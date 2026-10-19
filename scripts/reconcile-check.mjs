// npm run test:reconcile – Step 8 checks against REAL processes on a fresh temporary
// installation: all five services, the worker commands, and `npm run reconcile -- --once`
// exactly as an operator runs it. The ambiguous outcomes are produced for real: a bank that
// posts but answers too late, a CBI that is down, a Settlement service that is unreachable.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openMockCoreBankingDb, openTransactionDb } from '../lib/server/db/index.js';
import { createTransferWriter } from '../lib/server/transfer-orchestrator.js';
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-recon-'));
let services;
const current = {};
let db;
let bankDb;
const output = [];
try {
  await runSetup({ dataDir });
  services = await startAllServices({ dataDir, root });
  Object.assign(current, { bank: services.bank, cbi: services.cbi, settlement: services.settlement });
  db = openTransactionDb({ dataDir });
  bankDb = openMockCoreBankingDb({ dataDir, readonly: true });
  const writer = createTransferWriter(db);
  const transfer = (amountCents) => writer.create({
    customerId: 'cus_demo_alice', senderWalletId: 'wal_demo_alice', recipientWalletId: 'wal_demo_bob', amountCents, currency: 'USD',
    idempotencyKey: `recon-check-${crypto.randomBytes(8).toString('hex')}`, balanceCents: 10_000_000,
  }).transfer.transferId;
  const P = services.ports;
  const env = {
    ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_FRAUD_PORT: String(P.fraud), VAULTPAY_SETTLEMENT_PORT: String(P.settlement),
    VAULTPAY_IDENTITY_PORT: String(P.identity), VAULTPAY_CBI_PORT: String(P.cbi), VAULTPAY_RECONCILE_MIN_AGE_MS: '1000',
  };
  const cli = async (name, args = ['--once']) => {
    const r = await run(process.execPath, [path.join(root, 'services', 'orchestrator', `${name}.js`), ...args], { cwd: root, env, windowsHide: true });
    output.push(r.stdout, r.stderr);
    return r.stdout;
  };
  const status = (id) => db.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status;
  const postings = (id) => bankDb.prepare('SELECT count(*) AS n FROM posting WHERE reference = ?').get(id).n;
  const ledger = (id) => db.prepare('SELECT count(*) AS n FROM ledger_entry WHERE transfer_id = ?').get(id).n;
  const balance = (ref) => bankDb.prepare('SELECT balance_cents FROM account WHERE account_ref = ?').get(ref).balance_cents;
  const held = () => db.prepare("SELECT coalesce(sum(amount_cents), 0) AS c FROM transfer WHERE sender_wallet_id = 'wal_demo_alice' AND status IN ('pending_risk', 'pending_settlement', 'settlement_in_flight')").get().c;
  const restart = async (name, extra = {}) => {
    await current[name === 'mock-core-banking' ? 'bank' : name].stop();
    const portEnv = { 'mock-core-banking': { VAULTPAY_MOCK_BANK_PORT: String(P.bank) }, cbi: { VAULTPAY_CBI_PORT: String(P.cbi), VAULTPAY_MOCK_BANK_PORT: String(P.bank) }, settlement: { VAULTPAY_SETTLEMENT_PORT: String(P.settlement), VAULTPAY_IDENTITY_PORT: String(P.identity), VAULTPAY_CBI_PORT: String(P.cbi) } }[name];
    const svc = startService(name, { root, env: { VAULTPAY_DATA_DIR: dataDir, ...portEnv, ...extra } });
    await svc.listening;
    current[name === 'mock-core-banking' ? 'bank' : name] = svc;
  };
  /** Approved, then settled against a bank that posts but answers after CBI gave up. */
  const postedButLost = async (amounts) => {
    const ids = amounts.map((a) => transfer(a));
    await cli('fraud-worker');
    await restart('mock-core-banking', { VAULTPAY_MOCK_BANK_POST_DELAY_MS: '4500' });
    await cli('settlement-worker');
    await sleep(2000);
    await restart('mock-core-banking');
    return ids;
  };

  console.log('\nBank posted, answer lost → reconciliation completes');
  const [lost] = await postedButLost([1250]);
  check('settlement left the transfer in flight (outcome unknown) although the bank posted', status(lost) === 'settlement_in_flight' && postings(lost) === 1);
  await sleep(1100);
  const out1 = await cli('reconcile');
  check('npm run reconcile -- --once → completed=1', /completed=1/.test(out1), out1.trim().split('\n').at(-1));
  check('transfer completed with one ledger pair; one posting; Alice $487.50, Bob $262.50',
    status(lost) === 'completed' && ledger(lost) === 2 && postings(lost) === 1 && balance('MCB-1001') === 48_750 && balance('MCB-1002') === 26_250);
  const out1b = await cli('reconcile');
  const settleAfter = await cli('settlement-worker');
  check('repeated runs and the settlement worker change nothing', /nothing to reconcile/.test(out1b) && /nothing due/.test(settleAfter) && ledger(lost) === 2 && postings(lost) === 1);

  console.log('\nOutcome unknown while CBI is down');
  const [blind] = await postedButLost([700]);
  await current.cbi.stop();
  await sleep(1100);
  const out2 = await cli('reconcile');
  check('CBI down → unresolved; transfer stays in flight and its funds stay reserved', /unresolved=1/.test(out2) && status(blind) === 'settlement_in_flight' && held() === 700, out2.trim().split('\n').at(-1));
  await restart('cbi');
  await cli('reconcile');
  check('CBI back → completed with the original posting', status(blind) === 'completed' && postings(blind) === 1 && ledger(blind) === 2);

  console.log('\nNo posting at the bank');
  const never = transfer(300);
  await cli('fraud-worker');
  await current.settlement.stop();
  await cli('settlement-worker');
  check('Settlement unreachable → in flight, nothing at the bank', status(never) === 'settlement_in_flight' && postings(never) === 0);
  await sleep(1100);
  const out2b = await cli('reconcile');
  check('no posting found → NOT failed: still in flight, funds reserved (a late request could still post)',
    /not_found=1/.test(out2b) && status(never) === 'settlement_in_flight' && postings(never) === 0 && held() === 300, out2b.trim().split('\n').at(-1));
  await restart('settlement');
  await sleep(1100);
  await cli('settlement-worker');
  check('Settlement back → the SAME key is sent and settles it once', status(never) === 'completed' && postings(never) === 1 && ledger(never) === 2 && held() === 0);

  console.log('\nConcurrent reconciliation processes');
  const many = await postedButLost([101, 102, 103]);
  await sleep(1100);
  await Promise.all([cli('reconcile'), cli('reconcile'), cli('reconcile')]);
  check('3 processes, 3 ambiguous transfers: each completed once, one ledger pair and one posting each',
    many.every((id) => status(id) === 'completed' && ledger(id) === 2 && postings(id) === 1), JSON.stringify(many.map((id) => [status(id), ledger(id), postings(id)])));

  console.log('\nRecovery: expiry and parked messages');
  const stale = transfer(400);
  db.prepare('UPDATE transfer SET pending_expires_at = ? WHERE transfer_id = ?').run(Date.now() - 1000, stale); // simulate an overdue transfer
  await cli('reconcile');
  check('an overdue pending transfer expires and releases its reservation', status(stale) === 'expired' && held() === 0);
  const parked = transfer(500);
  db.prepare("UPDATE outbox_message SET status = 'dead', last_error = 'fraud_unavailable', attempts = 10, updated_at = ? WHERE transfer_id = ?").run(Date.now(), parked);
  await cli('fraud-worker');
  check('a parked fraud_check is not retried by the worker', status(parked) === 'pending_risk');
  const loopRefused = await run(process.execPath, [path.join(root, 'services', 'orchestrator', 'reconcile.js'), '--requeue-dead'], { cwd: root, env, windowsHide: true }).then(() => false, () => true);
  check('--requeue-dead only together with --once (an explicit operator action)', loopRefused);
  const out3 = await cli('reconcile', ['--once', '--requeue-dead']);
  await cli('fraud-worker');
  check('reconcile --once --requeue-dead → a new message; the transfer is screened', /requeued=1/.test(out3) && status(parked) === 'pending_settlement', out3.trim().split('\n').at(-1));

  console.log('\nLedger and logs');
  const t = db.prepare('SELECT debit_cents, credit_cents FROM ledger_totals').get();
  const last = (await cli('reconcile')).trim().split('\n').at(-1);
  check('ledger totals balance; the integrity check reports no issue', t.debit_cents === t.credit_cents && /integrity_issues=0/.test(last), `${JSON.stringify(t)} ${last}`);
  const logs = `${output.join('\n')}\n${[...Object.values(current), services.identity, services.fraud].map((s) => s.output()).join('\n')}`;
  const leaks = ['eyJ', 'PRIVATE KEY', loadProcessEnv('cbi', { dataDir }).values.MOCK_CORE_BANKING_API_KEY].filter((x) => logs.includes(x));
  check('no token, key or bank credential in any log', leaks.length === 0, leaks.map((l) => l.slice(0, 6)).join(', '));
  check('the reconciliation output names no bank account', !/MCB-1/.test(output.join('\n')));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  ${err.stack ?? err.message}`);
} finally {
  db?.close();
  bankDb?.close();
  if (services) await Promise.all([current.settlement?.stop(), services.fraud.stop(), current.cbi?.stop(), services.identity.stop(), current.bank?.stop()]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failures > 0) console.log(`\n--- output ---\n${output.join('\n').slice(-4000)}`);
console.log(failures === 0 ? '\nALL RECONCILIATION CHECKS PASSED' : `\n${failures} RECONCILIATION CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
