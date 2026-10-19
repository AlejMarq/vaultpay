// npm run test:fraud – Step 6 checks against REAL processes on a temporary installation:
// the Fraud & Risk service (services/fraud/server.js) and the fraud outbox worker command
// (services/orchestrator/fraud-worker.js), exactly as `npm run fraud` / `npm run fraud-worker`
// start them. Transfers are created with the Orchestrator's transfer writer, as /send does.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openTransactionDb } from '../lib/server/db/index.js';
import { createTransferWriter } from '../lib/server/transfer-orchestrator.js';
import { mtlsRequest } from '../lib/services/mtls-request.js';
import { loadProcessEnv, requireNode22 } from '../lib/services/process-env.js';

import { startService } from './lib/spawn-service.mjs';
import { runSetup } from './setup/run.mjs';

requireNode22();
const run = promisify(execFile);
const root = process.cwd();
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-fraud-'));
let fraud;
let db;
const workerOutput = [];
try {
  await runSetup({ dataDir });
  db = openTransactionDb({ dataDir });
  const writer = createTransferWriter(db);
  const transfer = (amountCents) => writer.create({
    customerId: 'cus_demo_alice', senderWalletId: 'wal_demo_alice', recipientWalletId: 'wal_demo_bob', amountCents, currency: 'USD',
    idempotencyKey: `fraud-check-${crypto.randomBytes(8).toString('hex')}`, balanceCents: 10_000_000,
  }).transfer.transferId;
  const status = (id) => db.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status;
  const decisions = (id) => db.prepare('SELECT count(*) AS n FROM risk_decision WHERE transfer_id = ?').get(id).n;

  const startFraud = async (port = 0, extra = {}) => {
    fraud = startService('fraud', { root, env: { VAULTPAY_DATA_DIR: dataDir, VAULTPAY_FRAUD_PORT: String(port), ...extra } });
    return fraud.listening;
  };
  let at = await startFraud();
  const worker = async () => {
    const { stdout, stderr } = await run(process.execPath, [path.join(root, 'services', 'orchestrator', 'fraud-worker.js'), '--once'], {
      cwd: root, env: { ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_FRAUD_PORT: String(at.port) }, windowsHide: true,
    });
    workerOutput.push(stdout, stderr);
    return stdout;
  };

  console.log('\nFraud & Risk service process');
  check('listens on 127.0.0.1 only', at.address === '127.0.0.1', at.address);
  const web = loadProcessEnv('web', { dataDir }).tls;
  const fromWeb = await mtlsRequest({ port: at.port, method: 'POST', path: '/v1/risk-decisions', credentials: web, expectedServer: 'vaultpay-fraud', body: {} });
  check('refuses Next.js\'s certificate (only vaultpay-orchestrator may ask)', fromWeb.status === 403, String(fromWeb.status));

  console.log('\nWorker command: approve and decline');
  const normal = transfer(1250);
  const risky = transfer(30_000);
  const out = await worker();
  check('worker --once screens both and exits', /done: .*pending_settlement=1/.test(out) && /declined=1/.test(out), out.trim().split('\n').at(-1));
  check('normal $12.50 → pending_settlement (one signed decision stored)', status(normal) === 'pending_settlement' && decisions(normal) === 1);
  check('high-risk $300.00 → declined', status(risky) === 'declined' && decisions(risky) === 1);
  check('approval queued for settlement; nothing completed or posted',
    db.prepare("SELECT count(*) AS n FROM outbox_message WHERE target = 'settlement' AND status = 'pending'").get().n === 1
    && db.prepare("SELECT count(*) AS n FROM transfer WHERE status = 'completed'").get().n === 0
    && db.prepare('SELECT count(*) AS n FROM ledger_entry').get().n === 0);
  check('a second run finds nothing to do', /nothing due/.test(await worker()));

  console.log('\nConcurrent worker processes');
  const many = Array.from({ length: 12 }, (_, i) => transfer(i % 4 === 0 ? 40_000 : 500 + i));
  await Promise.all([worker(), worker(), worker()]);
  check('3 workers, 12 transfers: each screened and applied exactly once', many.every((id) => decisions(id) === 1 && status(id) !== 'pending_risk'),
    JSON.stringify(many.map((id) => [status(id), decisions(id)])));
  check('every fraud_check message is done exactly once',
    db.prepare("SELECT count(*) AS n FROM outbox_message WHERE target = 'fraud_check' AND (status <> 'done' OR attempts <> 1)").get().n === 0);

  console.log('\nOutage and recovery');
  await fraud.stop();
  const waiting = transfer(2000);
  const downOut = await worker();
  const msg = () => db.prepare("SELECT status, attempts, last_error FROM outbox_message WHERE transfer_id = ? AND target = 'fraud_check'").get(waiting);
  check('Fraud & Risk down: the transfer stays pending_risk, the message waits for a retry',
    /retry=1/.test(downOut) && status(waiting) === 'pending_risk' && msg().status === 'pending' && msg().last_error === 'fraud_unavailable', JSON.stringify(msg()));
  at = await startFraud(at.port);
  await new Promise((r) => setTimeout(r, 1100)); // first backoff is 1 s
  await worker();
  check('after the service is back, the next run screens it', status(waiting) === 'pending_settlement' && decisions(waiting) === 1, status(waiting));

  console.log('\nConfigurable demo threshold');
  await fraud.stop();
  at = await startFraud(at.port, { VAULTPAY_FRAUD_DECLINE_AT_CENTS: '1000' });
  const small = transfer(1250);
  await worker();
  check('with VAULTPAY_FRAUD_DECLINE_AT_CENTS=1000 the same $12.50 is declined', status(small) === 'declined');

  console.log('\nNo secrets in logs');
  const fraudEnv = loadProcessEnv('fraud', { dataDir }).values;
  const logs = `${workerOutput.join('\n')}\n${fraud.output()}`;
  const leaks = [fraudEnv.RISK_DECISION_SIGNING_KEY, 'eyJ', 'PRIVATE KEY', 'BEGIN CERTIFICATE'].filter((s) => logs.includes(s));
  check('worker and service logs contain no key, certificate or decision token', leaks.length === 0, leaks.map((l) => l.slice(0, 8)).join(', '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  ${err.stack ?? err.message}`);
} finally {
  db?.close();
  await fraud?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failures > 0) console.log(`\n--- worker output ---\n${workerOutput.join('\n').slice(-3000)}\n--- fraud log ---\n${fraud?.output().slice(-2000)}`);
console.log(failures === 0 ? '\nALL FRAUD CHECKS PASSED' : `\n${failures} FRAUD CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
