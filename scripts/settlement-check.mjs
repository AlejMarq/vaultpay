// npm run test:settlement – Step 7 checks against REAL processes on a fresh temporary
// installation: mock Core Banking, Identity, CBI, Fraud & Risk and Settlement as separate
// processes, and the worker commands `fraud-worker --once` / `settlement-worker --once`
// exactly as `npm run` starts them. Transfers are created with the Orchestrator's transfer
// writer (as /send does); `npm run test:http` covers the same flow through the browser form.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openMockCoreBankingDb, openTransactionDb } from '../lib/server/db/index.js';
import { createTransferWriter } from '../lib/server/transfer-orchestrator.js';
import { mtlsRequest } from '../lib/services/mtls-request.js';
import { loadProcessEnv, requireNode22 } from '../lib/services/process-env.js';

import { startAllServices, startService } from './lib/spawn-service.mjs';
import { runSetup } from './setup/run.mjs';

requireNode22();
const run = promisify(execFile);
const root = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-settle-'));
let services;
let bank;
let db;
let bankDb;
const output = [];
try {
  await runSetup({ dataDir });
  // Fraud threshold raised so the bank (not fraud) is what refuses the large transfer below.
  services = await startAllServices({ dataDir, root, fraudEnv: { VAULTPAY_FRAUD_DECLINE_AT_CENTS: '1000000' } });
  bank = services.bank;
  db = openTransactionDb({ dataDir });
  bankDb = openMockCoreBankingDb({ dataDir, readonly: true });
  const writer = createTransferWriter(db);
  const transfer = (amountCents, to = 'wal_demo_bob') => writer.create({
    customerId: 'cus_demo_alice', senderWalletId: 'wal_demo_alice', recipientWalletId: to, amountCents, currency: 'USD',
    idempotencyKey: `settle-check-${crypto.randomBytes(8).toString('hex')}`, balanceCents: 10_000_000,
  }).transfer.transferId;
  const env = { ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_FRAUD_PORT: String(services.ports.fraud), VAULTPAY_SETTLEMENT_PORT: String(services.ports.settlement) };
  const cli = async (name, extraEnv = {}) => {
    const r = await run(process.execPath, [path.join(root, 'services', 'orchestrator', `${name}.js`), '--once'], { cwd: root, env: { ...env, ...extraEnv }, windowsHide: true });
    output.push(r.stdout, r.stderr);
    return r.stdout;
  };
  const status = (id) => db.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status;
  const balance = (ref) => bankDb.prepare('SELECT balance_cents FROM account WHERE account_ref = ?').get(ref).balance_cents;
  const postings = (id) => bankDb.prepare('SELECT count(*) AS n FROM posting WHERE reference = ?').get(id).n;
  const ledger = () => db.prepare('SELECT debit_cents, credit_cents, entries FROM ledger_totals').get();
  const restartBank = async (extra = {}) => {
    await bank.stop();
    bank = startService('mock-core-banking', { root, env: { VAULTPAY_DATA_DIR: dataDir, VAULTPAY_MOCK_BANK_PORT: String(services.ports.bank), ...extra } });
    await bank.listening;
  };

  console.log('\nThe payment: Alice → Bob $12.50');
  check('Settlement listens on 127.0.0.1 only', services.addresses.settlement.address === '127.0.0.1');
  check('fresh installation: Alice $500.00, Bob $250.00 at the bank', balance('MCB-1001') === 50_000 && balance('MCB-1002') === 25_000);
  const pay = transfer(1250);
  await cli('fraud-worker');
  check('fraud approves → pending_settlement', status(pay) === 'pending_settlement', status(pay));
  const out = await cli('settlement-worker');
  check('settlement-worker --once → completed', /completed=1/.test(out) && status(pay) === 'completed', out.trim().split('\n').at(-1));
  check('bank: Alice $487.50, Bob $262.50', balance('MCB-1001') === 48_750 && balance('MCB-1002') === 26_250, `${balance('MCB-1001')} / ${balance('MCB-1002')}`);
  check('ledger: one debit and one credit of $12.50, totals balance', JSON.stringify(ledger()) === JSON.stringify({ debit_cents: 1250, credit_cents: 1250, entries: 2 }), JSON.stringify(ledger()));
  const link = db.prepare("SELECT e.core_banking_ref AS ledger_ref, a.core_banking_ref AS attempt_ref FROM ledger_entry e JOIN settlement_attempt a ON a.transfer_id = e.transfer_id WHERE e.transfer_id = ? AND e.direction = 'debit'").get(pay);
  const bankRef = bankDb.prepare('SELECT posting_ref FROM posting WHERE reference = ?').get(pay)?.posting_ref;
  check('ledger, settlement attempt and bank posting share one posting reference', link?.ledger_ref === bankRef && link?.attempt_ref === bankRef && /^MCBP-/.test(bankRef ?? ''));

  console.log('\nThe bank decides');
  const tooBig = transfer(60_000); // Alice now has $487.50
  await cli('fraud-worker');
  await cli('settlement-worker');
  check('insufficient funds at the bank → failed, nothing moved', status(tooBig) === 'failed' && postings(tooBig) === 0 && balance('MCB-1001') === 48_750);
  const restricted = transfer(100, 'wal_demo_carol');
  await cli('fraud-worker');
  const bankWrite = openMockCoreBankingDb({ dataDir });
  bankWrite.prepare("UPDATE account SET status = 'frozen' WHERE account_ref = 'MCB-1003'").run();
  await cli('settlement-worker');
  bankWrite.prepare("UPDATE account SET status = 'active' WHERE account_ref = 'MCB-1003'").run();
  bankWrite.close();
  check('recipient account frozen at the bank → failed, nothing moved', status(restricted) === 'failed' && postings(restricted) === 0 && balance('MCB-1003') === 10_000);

  console.log('\nBank timeout after posting');
  await restartBank({ VAULTPAY_MOCK_BANK_POST_DELAY_MS: '4500' }); // CBI waits 3 s
  const slow = transfer(700);
  await cli('fraud-worker');
  const slowOut = await cli('settlement-worker');
  const attempt = () => db.prepare('SELECT outcome, idempotency_key FROM settlement_attempt WHERE transfer_id = ?').all(slow);
  check('no answer in time → outcome unknown, still in flight (not failed)', /retry=1/.test(slowOut) && status(slow) === 'settlement_in_flight' && attempt()[0]?.outcome === 'unknown', JSON.stringify(attempt()));
  check('…although the bank did post', postings(slow) === 1);
  await sleep(2000);
  await restartBank();
  await sleep(1200); // first backoff
  await cli('settlement-worker');
  check('retry with the SAME key → bank returns the original posting → completed, money moved once',
    status(slow) === 'completed' && postings(slow) === 1 && attempt().length === 1 && balance('MCB-1001') === 48_050, `${status(slow)} postings=${postings(slow)} alice=${balance('MCB-1001')}`);

  console.log('\nWorker crash and recovery');
  await restartBank({ VAULTPAY_MOCK_BANK_POST_DELAY_MS: '8000' });
  const crash = transfer(300);
  await cli('fraud-worker');
  const looping = spawn(process.execPath, [path.join(root, 'services', 'orchestrator', 'settlement-worker.js')], { cwd: root, env: { ...env, VAULTPAY_SETTLEMENT_LEASE_MS: '5000' }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && postings(crash) === 0; i += 1) await sleep(100);
  looping.kill('SIGKILL');
  await new Promise((r) => looping.on('exit', r));
  check('worker killed after the bank posted: transfer still in flight', postings(crash) === 1 && status(crash) === 'settlement_in_flight', status(crash));
  await restartBank();
  await sleep(5500); // the dead worker's lease runs out
  await cli('settlement-worker', { VAULTPAY_SETTLEMENT_LEASE_MS: '5000' });
  check('another run resumes with the same key → completed, one posting', status(crash) === 'completed' && postings(crash) === 1, status(crash));

  console.log('\nConcurrent settlement workers');
  const many = Array.from({ length: 6 }, (_, i) => transfer(100 + i));
  await cli('fraud-worker');
  const before = balance('MCB-1001');
  await Promise.all([cli('settlement-worker'), cli('settlement-worker'), cli('settlement-worker')]);
  const sum = many.reduce((n, _, i) => n + 100 + i, 0);
  check('3 worker processes, 6 transfers: each completed with exactly one posting',
    many.every((id) => status(id) === 'completed' && postings(id) === 1) && balance('MCB-1001') === before - sum, JSON.stringify(many.map((id) => [status(id), postings(id)])));
  const totals = ledger();
  check('ledger totals: debits = credits', totals.debit_cents === totals.credit_cents && totals.entries % 2 === 0, JSON.stringify(totals));

  console.log('\nSettlement tokens at the real CBI');
  const tokenTest = transfer(50);
  await cli('fraud-worker');
  const settlementTls = loadProcessEnv('settlement', { dataDir }).tls;
  const approval = db.prepare('SELECT signature FROM risk_decision WHERE transfer_id = ?').get(tokenTest).signature;
  const issued = await mtlsRequest({ port: services.ports.identity, method: 'POST', path: '/v1/service-tokens/settlement', credentials: settlementTls, expectedServer: 'vaultpay-identity', body: { riskDecision: approval, idempotencyKey: `stlk_${crypto.randomBytes(12).toString('hex')}` } });
  const post = (token) => mtlsRequest({ port: services.ports.cbi, method: 'POST', path: '/v1/postings', credentials: settlementTls, expectedServer: 'vaultpay-cbi', headers: { authorization: `Bearer ${token}` } });
  const [h, p, s] = issued.json.token.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), credit_account: 'MCB-1003' })).toString('base64url')}.${s}`;
  check('a tampered settlement token (other credit account) is refused', (await post(tampered)).status === 401);
  const first = await post(issued.json.token);
  const replay = await post(issued.json.token);
  check('a settlement token works once; its replay is refused', first.status === 200 && replay.status === 401, `${first.status} / ${replay.status}`);
  const web = loadProcessEnv('web', { dataDir }).tls;
  const fromWeb = await mtlsRequest({ port: services.ports.identity, method: 'POST', path: '/v1/service-tokens/settlement', credentials: web, expectedServer: 'vaultpay-identity', body: { riskDecision: approval, idempotencyKey: `stlk_${crypto.randomBytes(12).toString('hex')}` } });
  check('Next.js cannot obtain a settlement token', fromWeb.status === 403);

  console.log('\nNo secrets in logs');
  const logs = `${output.join('\n')}\n${Object.values(services).filter((x) => x?.output).map((x) => x.output()).join('\n')}\n${bank.output()}`;
  const leaks = ['eyJ', 'PRIVATE KEY', loadProcessEnv('cbi', { dataDir }).values.MOCK_CORE_BANKING_API_KEY].filter((x) => logs.includes(x));
  check('service and worker logs contain no token, key or bank credential', leaks.length === 0, leaks.map((l) => l.slice(0, 6)).join(', '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  ${err.stack ?? err.message}`);
} finally {
  db?.close();
  bankDb?.close();
  if (services) await Promise.all([services.settlement.stop(), services.fraud.stop(), services.cbi.stop(), services.identity.stop(), bank.stop()]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failures > 0) console.log(`\n--- worker output ---\n${output.join('\n').slice(-4000)}`);
console.log(failures === 0 ? '\nALL SETTLEMENT CHECKS PASSED' : `\n${failures} SETTLEMENT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
