import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';

import { fetchCustomerBalance } from '../../lib/server/balance.js';
import { AccessDenied } from '../../lib/server/dal.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { formatCents, MAX_TRANSFER_CENTS, parseUsdToCents } from '../../lib/server/money.js';
import { initiateTransfer, reviewTransfer } from '../../lib/server/transfer-initiation.js';
import { createTransferRateLimiter, TRANSFER_LIMITS } from '../../lib/server/rate-limit.js';
import { canTransition, createTransferWriter, HOLDING_STATUSES, MAX_PENDING_PER_WALLET, TRANSFER_TRANSITIONS } from '../../lib/server/transfer-orchestrator.js';
import { recentTransfers } from '../../lib/server/transfers.js';
import { getWalletOverview } from '../../lib/server/wallet.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { freshDb, onCleanup, T0 } from '../helpers/db.mjs';
import { servicesHarness } from '../helpers/services.mjs';

const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;
const STATUSES = Object.keys(TRANSFER_TRANSITIONS);

// ---------------------------------------------------------------------------
// Money parsing (integer cents, no floating point)
// ---------------------------------------------------------------------------
test('amounts are parsed to integer cents from strings; everything else is refused', () => {
  for (const [input, cents] of [['12', 1200], ['12.5', 1250], ['12.50', 1250], ['0.01', 1], ['$7.05', 705], [' 1000.00 ', 100_000], ['0.1', 10], ['1000000.99', 100_000_099]]) {
    assert.equal(parseUsdToCents(input), cents, input);
  }
  // 0.29 * 100 is 28.999999999999996 in floating point; string parsing is exact.
  assert.equal(parseUsdToCents('0.29'), 29);
  assert.equal(parseUsdToCents('1.15'), 115);
  for (const bad of ['', ' ', '-1', '+1', '1e3', '12.345', '1,000', '01', '00.5', '.5', '5.', 'abc', '12 34', '١٢', 'Infinity', 'NaN', '0x10', '10000000', null, undefined, 12, {}, []]) {
    assert.equal(parseUsdToCents(bad), null, JSON.stringify(bad));
  }
  assert.equal(formatCents(123_456), '$1,234.56');
  assert.equal(formatCents(5), '$0.05');
});

// ---------------------------------------------------------------------------
// State machine: the JS table matches the database trigger exactly
// ---------------------------------------------------------------------------
test('transfer status transitions in code match the database trigger; a new transfer is never completed', (t) => {
  const { db } = freshDb(t, 'transaction');
  let n = 0;
  const insert = () => {
    const id = `trf_sm${(n += 1)}`;
    db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, idempotency_key, status, pending_expires_at, created_at, updated_at)
      VALUES (?, 'wal_a', 'wallet', 'wal_b', 100, ?, 'pending_risk', ${T0 + 1000}, ${T0}, ${T0})`).run(id, `idem-sm-${n}-xxxxxxxx`);
    return id;
  };
  const SETTLED = new Set(['settlement_in_flight', 'completed', 'failed']);
  // Since v5 completed/failed also need the matching settlement attempt (Step 7); add it
  // whenever the transfer is in flight, so only the transition trigger decides.
  const prepareOutcome = (id, to) => {
    if (!['completed', 'failed'].includes(to) || db.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status !== 'settlement_in_flight') return;
    db.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
      VALUES (?, ?, 'approve', 1, 'eyJhbGciOiJFZERTQSJ9.payload.sig', 'v1', ${T0}, ${T0 + 60_000}, ${T0})`).run(`rsk_${id}`, id);
    db.prepare(`INSERT INTO settlement_attempt (attempt_id, transfer_id, decision_id, attempt_no, idempotency_key, requested_at, outcome)
      VALUES (?, ?, ?, 1, ?, ${T0 + 6}, 'pending')`).run(`stl_${id}`, id, `rsk_${id}`, `stlk-${id}-xxxxxxxx`);
    db.prepare(`UPDATE settlement_attempt SET outcome = ?, core_banking_ref = ?, completed_at = ${T0 + 7} WHERE attempt_id = ?`)
      .run(to === 'completed' ? 'settled' : 'failed', to === 'completed' ? 'MCBP-test' : null, `stl_${id}`);
  };
  const move = (id, to) => {
    prepareOutcome(id, to);
    db.prepare(`UPDATE transfer SET status = ?, updated_at = updated_at + 1,
        settlement_attempted_at = CASE WHEN ? THEN coalesce(settlement_attempted_at, ${T0 + 5}) ELSE settlement_attempted_at END
      WHERE transfer_id = ?`).run(to, SETTLED.has(to) ? 1 : 0, id);
  };
  // A path from pending_risk to every status, using only allowed steps.
  const PATH = {
    pending_risk: [], pending_settlement: ['pending_settlement'], settlement_in_flight: ['pending_settlement', 'settlement_in_flight'],
    completed: ['pending_settlement', 'settlement_in_flight', 'completed'], failed: ['pending_settlement', 'settlement_in_flight', 'failed'],
    declined: ['declined'], expired: ['expired'],
  };
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;
      const id = insert();
      for (const step of PATH[from]) move(id, step);
      let error = null;
      try {
        move(id, to);
      } catch (err) {
        error = err.message;
      }
      if (canTransition(from, to)) assert.equal(error, null, `${from} → ${to} should be allowed`);
      else assert.match(error ?? '', /invalid transfer status transition|only after a settled bank posting|fails only after/, `${from} → ${to} should be refused by a trigger`);
    }
  }
  for (const status of STATUSES.filter((s) => s !== 'pending_risk')) {
    assert.throws(() => db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, idempotency_key, status, pending_expires_at, settlement_attempted_at, created_at, updated_at)
      VALUES ('trf_new_${status}', 'wal_a', 'wallet', 'wal_b', 100, 'idem-new-${status}', ?, ${T0 + 1000}, ${T0}, ${T0}, ${T0})`).run(status), /pending_risk|CHECK/, status);
  }
  assert.deepEqual([...HOLDING_STATUSES], ['pending_risk', 'pending_settlement', 'settlement_in_flight']);
});

// ---------------------------------------------------------------------------
// End to end through the real balance flow (Identity → CBI → mock Core Banking)
// ---------------------------------------------------------------------------
async function transferHarness(t) {
  const s = await servicesHarness(t);
  const writer = createTransferWriter(s.transactionRw);
  const logs = [];
  const deps = (browser, extra = {}) => ({
    identityDb: s.identityRo, writer, log: (m) => logs.push(m),
    fetchBalance: () => fetchCustomerBalance(browser.viewer, s.balanceDeps(browser.browser)),
    ...extra,
  });
  const rows = () => ({
    transfers: s.transactionRo.prepare('SELECT * FROM transfer ORDER BY created_at, rowid').all(),
    audit: s.transactionRo.prepare("SELECT * FROM audit_event WHERE event_type LIKE 'transfer.%' ORDER BY rowid").all(),
    outbox: s.transactionRo.prepare('SELECT * FROM outbox_message ORDER BY rowid').all(),
    ledger: s.transactionRo.prepare('SELECT count(*) AS n FROM ledger_entry').get().n,
  });
  /** Review then confirm, like the form. */
  const send = async (who, recipientEmail, amount, extra) => {
    const review = reviewTransfer(who.viewer, { recipientEmail, amount }, { identityDb: s.identityRo });
    if (review.step !== 'confirm') return review;
    return initiateTransfer(who.viewer, { ...review.review, recipientEmail: review.review.recipient }, deps(who, extra));
  };
  const login = async (user) => {
    const r = await s.verifiedLogin(user);
    return { ...r, viewer: r.viewer };
  };
  return { s, writer, deps, rows, send, login, logs };
}

const deniedWith = (reason, details) => (err) => {
  assert.ok(err instanceof AccessDenied, err.message);
  assert.equal(err.reason, reason);
  if (details) assert.deepEqual([...err.details], details);
  return true;
};

test('Alice sends $12.50 to Bob: one pending transfer, its audit event and fraud-check outbox message', async (t) => {
  const { s, rows, send, login } = await transferHarness(t);
  const a = await login(alice);
  const before = Date.now();

  const review = reviewTransfer(a.viewer, { recipientEmail: ' Bob@Example.test ', amount: '12.5' }, { identityDb: s.identityRo });
  assert.equal(review.step, 'confirm');
  assert.deepEqual({ ...review.review, idempotencyKey: typeof review.review.idempotencyKey }, {
    recipient: 'bob@example.test', amount: '12.50', amountCents: 1250, currency: 'USD', sourceWalletId: 'wal_demo_alice', idempotencyKey: 'string',
  });
  assert.deepEqual(rows().transfers, [], 'reviewing writes nothing');

  const result = await send(a, 'bob@example.test', '12.50');
  assert.equal(result.step, 'done', JSON.stringify(result));
  assert.equal(result.replayed, false);
  assert.equal(result.transfer.status, 'pending_risk');
  assert.equal(result.transfer.amountCents, 1250);

  const { transfers, audit, outbox, ledger } = rows();
  assert.equal(transfers.length, 1);
  const [trf] = transfers;
  assert.match(trf.transfer_id, /^trf_[0-9a-f]{24}$/);
  assert.equal(trf.transfer_id, result.transfer.transferId);
  assert.deepEqual(
    { sender: trf.sender_wallet_id, type: trf.payee_type, payee: trf.payee_id, amount: trf.amount_cents, currency: trf.currency, status: trf.status, attempted: trf.settlement_attempted_at },
    { sender: 'wal_demo_alice', type: 'wallet', payee: 'wal_demo_bob', amount: 1250, currency: 'USD', status: 'pending_risk', attempted: null },
  );
  assert.ok(trf.created_at >= before && trf.updated_at === trf.created_at);
  assert.equal(trf.pending_expires_at, trf.created_at + 60 * 60 * 1000);

  assert.equal(audit.length, 1);
  assert.deepEqual(
    { transfer: audit[0].transfer_id, wallet: audit[0].subject_wallet_id, actorType: audit[0].actor_type, actor: audit[0].actor_id, type: audit[0].event_type, at: audit[0].occurred_at },
    { transfer: trf.transfer_id, wallet: 'wal_demo_alice', actorType: 'customer', actor: 'cus_demo_alice', type: 'transfer.requested', at: trf.created_at },
  );
  assert.equal(outbox.length, 1);
  assert.deepEqual(
    { transfer: outbox[0].transfer_id, target: outbox[0].target, status: outbox[0].status, attempts: outbox[0].attempts, lease: outbox[0].lease_until },
    { transfer: trf.transfer_id, target: 'fraud_check', status: 'pending', attempts: 0, lease: null },
  );
  assert.equal(ledger, 0, 'nothing is posted: settlement is Step 7');

  // The wallet pages: Alice sees it as sent and pending (and held); Bob as received and pending; Carol not at all.
  const aliceView = getWalletOverview(a.viewer, { identityDb: s.identityRo, transactionDb: s.transactionRo });
  assert.equal(aliceView.transfers[0].transferId, trf.transfer_id);
  assert.equal(aliceView.transfers[0].status, 'pending_risk');
  assert.equal(aliceView.pendingOutgoingCents, 1250);
  const bobHistory = recentTransfers({ transactionDb: s.transactionRo, identityDb: s.identityRo, walletId: 'wal_demo_bob' });
  assert.deepEqual([bobHistory[0].transferId, bobHistory[0].direction, bobHistory[0].status], [trf.transfer_id, 'received', 'pending_risk']);
  assert.deepEqual(recentTransfers({ transactionDb: s.transactionRo, identityDb: s.identityRo, walletId: 'wal_demo_carol' }), []);

  // Nothing banking-internal reaches the browser state.
  const out = JSON.stringify([review, result]);
  for (const secret of ['MCB-', 'eyJ', 'balance', '50000', 'cus_demo_bob', 'Bob Demo']) assert.ok(!out.includes(secret), secret);
});

test('Carol (KYC pending), support, password-only, suspended and frozen-wallet sessions cannot create transfers', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  const input = { recipientEmail: bob.email, amount: '5.00', sourceWalletId: 'wal_demo_carol', idempotencyKey: 'test-key-0000000001' };

  const c = await login(carol);
  assert.throws(() => reviewTransfer(c.viewer, input, { identityDb: s.identityRo }), deniedWith('not-eligible', ['kyc_pending']));
  await assert.rejects(initiateTransfer(c.viewer, input, deps(c)), deniedWith('not-eligible', ['kyc_pending']));

  const sp = await login(support);
  await assert.rejects(initiateTransfer(sp.viewer, input, deps(sp)), deniedWith('wrong-role'));

  const { browser } = await s.passwordLogin(bob);
  const pwOnly = { viewer: await s.viewerOf(browser), browser };
  await assert.rejects(initiateTransfer(pwOnly.viewer, { ...input, recipientEmail: alice.email, sourceWalletId: 'wal_demo_bob' }, deps(pwOnly)), deniedWith('mfa-required'));

  const a = await login(alice);
  const aliceInput = { ...input, sourceWalletId: 'wal_demo_alice' };
  s.identityDb.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_alice'").run();
  await assert.rejects(initiateTransfer(a.viewer, aliceInput, deps(a)), deniedWith('not-eligible', ['wallet_frozen']));
  s.identityDb.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_alice'").run();
  s.identityDb.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run();
  // The viewer was resolved while active; the database says suspended now.
  await assert.rejects(initiateTransfer(a.viewer, aliceInput, deps(a)), deniedWith('not-eligible', ['customer_inactive']));
  await assert.rejects(initiateTransfer(await s.viewerOf(a.browser), aliceInput, deps(a)), deniedWith('inactive'));
  s.identityDb.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_alice'").run();

  assert.deepEqual(rows().transfers, []);
  assert.deepEqual(rows().audit, []);
  assert.deepEqual(rows().outbox, []);
});

test('a freeze, KYC change or recipient change while the balance is being fetched still stops the transfer', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  const a = await login(alice);
  const review = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '10' }, { identityDb: s.identityRo }).review;
  const input = { ...review, recipientEmail: review.recipient };
  const during = (sql, undo) => ({
    fetchBalance: async () => {
      const balance = await fetchCustomerBalance(a.viewer, s.balanceDeps(a.browser));
      s.identityDb.prepare(sql).run();
      return balance;
    },
    undo: () => s.identityDb.prepare(undo).run(),
  });

  const freeze = during("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_alice'", "UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_alice'");
  await assert.rejects(initiateTransfer(a.viewer, input, deps(a, freeze)), deniedWith('not-eligible', ['wallet_frozen']));
  freeze.undo();

  const kyc = during(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
    VALUES ('kyc_mid', 'cus_demo_alice', 'pending', 'test', NULL, ${Date.now() + 5000})`, 'SELECT 1');
  await assert.rejects(initiateTransfer(a.viewer, input, deps(a, kyc)), deniedWith('not-eligible', ['kyc_pending']));
  s.identityDb.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
    VALUES ('kyc_again', 'cus_demo_alice', 'approved', 'test', ${Date.now() + 6000}, ${Date.now() + 6000})`).run();

  const recipient = during("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_bob'", "UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_bob'");
  const r = await initiateTransfer(a.viewer, input, deps(a, recipient));
  assert.deepEqual([r.step, r.error], ['edit', 'invalid_recipient']);
  recipient.undo();

  assert.deepEqual(rows().transfers, []);
  // The same request goes through once nothing is in the way.
  assert.equal((await initiateTransfer(a.viewer, input, deps(a))).step, 'done');
});

test('invalid amounts, limits, self-transfers and malformed requests are refused without writing', async (t) => {
  const { s, rows, send, deps, login } = await transferHarness(t);
  const a = await login(alice);
  for (const amount of ['', '0', '0.00', '-5', '1e2', '12.345', '1,000', 'abc', '01']) {
    const r = await send(a, bob.email, amount);
    assert.deepEqual([r.step, r.error], ['edit', amount === '0' || amount === '0.00' ? 'amount_out_of_range' : 'invalid_amount'], amount);
  }
  const overLimit = await send(a, bob.email, '1000.01');
  assert.deepEqual([overLimit.step, overLimit.error], ['edit', 'amount_out_of_range']);
  assert.equal(MAX_TRANSFER_CENTS, 100_000);

  for (const email of [alice.email, 'ALICE@example.test', ' alice@example.test ']) {
    const r = await send(a, email, '5');
    assert.deepEqual([r.step, r.error], ['edit', 'self_transfer'], email);
  }
  for (const email of ['', 'not-an-email', 'a'.repeat(300) + '@x.test']) {
    assert.equal((await send(a, email, '5')).error, 'invalid_recipient', email);
  }

  // Values the browser could tamper with on the confirm step.
  const good = { recipientEmail: bob.email, amount: '5.00', sourceWalletId: 'wal_demo_alice', idempotencyKey: 'tamper-key-00000001' };
  for (const [change, error] of [
    [{ idempotencyKey: 'short' }, 'invalid_request'],
    [{ idempotencyKey: 'bad key with spaces!!' }, 'invalid_request'],
    [{ idempotencyKey: undefined }, 'invalid_request'],
    [{ amount: '-5.00' }, 'invalid_amount'],
    [{ amount: 500 }, 'invalid_amount'],
  ]) {
    const r = await initiateTransfer(a.viewer, { ...good, ...change }, deps(a));
    assert.deepEqual([r.step, r.error], ['edit', error], JSON.stringify(change));
  }
  assert.deepEqual(rows().transfers, []);
});

test('recipient isolation: unknown, staff, suspended and frozen recipients all get the same answer', async (t) => {
  const { s, rows, send, login } = await transferHarness(t);
  const a = await login(alice);
  // Reviewing never looks the recipient up: known and unknown emails get the same review.
  const known = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '1' }, { identityDb: s.identityRo });
  const unknown = reviewTransfer(a.viewer, { recipientEmail: 'nobody@example.test', amount: '1' }, { identityDb: s.identityRo });
  assert.deepEqual(Object.keys(known.review), Object.keys(unknown.review));
  assert.equal(known.step, unknown.step);

  const answers = [];
  answers.push(await send(a, 'nobody@example.test', '1'));
  answers.push(await send(a, support.email, '1'));
  s.identityDb.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_bob'").run();
  answers.push(await send(a, bob.email, '1'));
  s.identityDb.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_bob'").run();
  s.identityDb.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_bob'").run();
  answers.push(await send(a, bob.email, '1'));
  s.identityDb.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_bob'").run();
  for (const r of answers) assert.deepEqual([r.step, r.error, Object.keys(r.values)], ['edit', 'invalid_recipient', ['recipient', 'amount']]);
  assert.ok(!JSON.stringify(answers).match(/wal_|cus_|Demo|ops_/), 'no wallet, customer id or name of the recipient is returned');
  // Carol (KYC pending) may receive: only the sender needs approved KYC.
  assert.equal((await send(a, carol.email, '1')).step, 'done');
  assert.equal(rows().transfers.length, 1);
});

test('the source wallet is the server\'s: another customer\'s wallet in the request is refused', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  const a = await login(alice);
  for (const sourceWalletId of ['wal_demo_bob', 'wal_demo_carol', '', 'wal_demo_alice ']) {
    const r = await initiateTransfer(a.viewer, { recipientEmail: bob.email, amount: '5', sourceWalletId, idempotencyKey: 'source-key-00000001' }, deps(a));
    assert.deepEqual([r.step, r.error], ['edit', 'source_wallet_changed'], sourceWalletId);
  }
  // A second, newer wallet (not the one the balance flow uses) is not sent from either.
  s.identityDb.prepare("UPDATE wallet SET status = 'closed' WHERE wallet_id = 'wal_demo_alice'").run();
  s.identityDb.prepare(`INSERT INTO wallet (wallet_id, customer_id, core_account_ref, status, created_at) VALUES ('wal_alice_new', 'cus_demo_alice', 'MCB-9001', 'active', ${Date.now()})`).run();
  const a2 = { ...a, viewer: await s.viewerOf(a.browser) };
  const r = await initiateTransfer(a2.viewer, { recipientEmail: bob.email, amount: '5', sourceWalletId: 'wal_alice_new', idempotencyKey: 'source-key-00000002' }, deps(a2));
  assert.deepEqual([r.step, r.error], ['edit', 'source_wallet_changed']);
  assert.deepEqual(rows().transfers, []);
});

test('insufficient funds: the bank balance minus transfers still on hold', async (t) => {
  const { rows, send, login } = await transferHarness(t);
  const a = await login(alice); // $500.00 at the bank
  const tooMuch = await send(a, bob.email, '500.01');
  assert.deepEqual([tooMuch.step, tooMuch.error], ['edit', 'insufficient_funds']);
  assert.equal((await send(a, bob.email, '400')).step, 'done');
  const second = await send(a, bob.email, '100.01'); // only $100.00 is not on hold
  assert.deepEqual([second.step, second.error], ['edit', 'insufficient_funds']);
  assert.equal((await send(a, bob.email, '100.00')).step, 'done');
  assert.equal((await send(a, bob.email, '0.01')).error, 'insufficient_funds');
  assert.deepEqual(rows().transfers.map((r) => r.amount_cents), [40_000, 10_000]);
});

test('idempotency: a repeat returns the same transfer; a changed payload is refused; parallel repeats create one', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  const a = await login(alice);
  const review = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '20' }, { identityDb: s.identityRo }).review;
  const input = { ...review, recipientEmail: review.recipient };

  const first = await initiateTransfer(a.viewer, input, deps(a));
  const again = await initiateTransfer(a.viewer, input, deps(a));
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.transfer.transferId, first.transfer.transferId);
  assert.deepEqual({ ...again, replayed: false }, first);

  for (const change of [{ amount: '20.01' }, { recipientEmail: carol.email }]) {
    const r = await initiateTransfer(a.viewer, { ...input, ...change }, deps(a));
    assert.deepEqual([r.step, r.error], ['edit', 'idempotency_conflict'], JSON.stringify(change));
  }

  // Ten simultaneous submissions of one new intended transfer (double clicks, retries).
  const key = 'parallel-key-000000001';
  const results = await Promise.all(Array.from({ length: 10 }, () => initiateTransfer(a.viewer, { ...input, idempotencyKey: key }, deps(a))));
  assert.ok(results.every((r) => r.step === 'done'), JSON.stringify(results.map((r) => r.error)));
  assert.equal(new Set(results.map((r) => r.transfer.transferId)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);

  const { transfers, audit, outbox } = rows();
  assert.equal(transfers.length, 2);
  assert.equal(audit.length, 2, 'one audit event per transfer, none for repeats');
  assert.equal(outbox.length, 2, 'one outbox message per transfer, none for repeats');
  // The same key is per sender: Bob may use it for his own transfer.
  const b = await login(bob);
  const bobResult = await initiateTransfer(b.viewer, { recipientEmail: alice.email, amount: '1', sourceWalletId: 'wal_demo_bob', idempotencyKey: key }, deps(b));
  assert.equal(bobResult.step, 'done');
  assert.notEqual(bobResult.transfer.transferId, results[0].transfer.transferId);
});

// Several connections (worker threads) writing at the same moment.
async function race(dataDir, requests) {
  const gate = new SharedArrayBuffer(4);
  const workers = requests.map((request) => new Worker(new URL('../helpers/transfer-worker.mjs', import.meta.url), { workerData: { dataDir, request, gate } }));
  const results = workers.map((w) => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); }));
  await new Promise((r) => setTimeout(r, 300)); // let every worker open its connection
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const out = await Promise.all(results);
  await Promise.all(workers.map((w) => w.terminate()));
  return out;
}

test('concurrent writers on separate connections: one transfer per key, and no overspending', async (t) => {
  const { s, rows } = await transferHarness(t);
  const base = { customerId: 'cus_demo_alice', senderWalletId: 'wal_demo_alice', recipientWalletId: 'wal_demo_bob', currency: 'USD', balanceCents: 50_000 };

  const sameKey = await race(s.dataDir, Array.from({ length: 6 }, () => ({ ...base, amountCents: 1000, idempotencyKey: 'race-same-key-0001' })));
  assert.ok(sameKey.every((r) => r.ok), JSON.stringify(sameKey));
  assert.equal(new Set(sameKey.map((r) => r.transferId)).size, 1);
  assert.equal(sameKey.filter((r) => !r.replayed).length, 1);

  // $490.00 left; six different transfers of $200.00 each: exactly two fit.
  const spend = await race(s.dataDir, Array.from({ length: 6 }, (_, i) => ({ ...base, amountCents: 20_000, idempotencyKey: `race-spend-key-000${i}` })));
  assert.equal(spend.filter((r) => r.ok).length, 2, JSON.stringify(spend));
  assert.ok(spend.filter((r) => !r.ok).every((r) => r.code === 'insufficient_funds'));

  const { transfers, audit, outbox } = rows();
  assert.equal(transfers.length, 3);
  assert.deepEqual([audit.length, outbox.length], [3, 3]);
});

test('banking outages fail closed; a recorded transfer can still be confirmed again', async (t) => {
  const { s, rows, deps, login, logs } = await transferHarness(t);
  const a = await login(alice);
  const review = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '15' }, { identityDb: s.identityRo }).review;
  const input = { ...review, recipientEmail: review.recipient };

  for (const fetchBalance of [async () => ({ available: false }), async () => null, async () => ({ available: true, balanceCents: 1e6, currency: 'EUR', status: 'active' }),
    async () => ({ available: true, balanceCents: 1e6, currency: 'USD', status: 'frozen' })]) {
    const r = await initiateTransfer(a.viewer, input, deps(a, { fetchBalance }));
    // Back to the confirm step with the same key, so "try again" cannot duplicate.
    assert.deepEqual([r.step, r.error, r.review?.idempotencyKey], ['confirm', 'banking_unavailable', review.idempotencyKey]);
  }
  await s.close(s.bank);
  const bankDown = await initiateTransfer(a.viewer, input, deps(a));
  assert.deepEqual([bankDown.step, bankDown.error], ['confirm', 'banking_unavailable']);
  assert.deepEqual(rows().transfers, []);

  await s.close(s.cbi);
  const other = await initiateTransfer(a.viewer, { ...input, idempotencyKey: 'outage-key-00000001' }, deps(a, { fetchBalance: async () => ({ available: true, balanceCents: 50_000, currency: 'USD', status: 'active' }) }));
  assert.equal(other.step, 'done');
  const replay = await initiateTransfer(a.viewer, { ...input, idempotencyKey: 'outage-key-00000001' }, deps(a));
  assert.deepEqual([replay.step, replay.replayed, replay.transfer.transferId], ['done', true, other.transfer.transferId], 'answered from the database while banking is down');
  assert.deepEqual(logs, []);
  assert.ok(!JSON.stringify([bankDown, replay]).match(/ECONN|cbi_|MCB-|eyJ|Error/));
});

test('database errors: nothing is half-written and nothing is reported as sent', async (t) => {
  const { s, rows, deps, login, logs } = await transferHarness(t);
  const a = await login(alice);
  const review = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '30' }, { identityDb: s.identityRo }).review;
  const input = { ...review, recipientEmail: review.recipient };

  // The outbox insert fails after the transfer and audit rows were written: all roll back.
  const failing = openTransactionDb({ dataDir: s.dataDir });
  onCleanup(t, () => failing.close());
  failing.exec("CREATE TEMP TRIGGER fail_outbox BEFORE INSERT ON outbox_message BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END");
  const r1 = await initiateTransfer(a.viewer, input, deps(a, { writer: createTransferWriter(failing) }));
  assert.deepEqual([r1.step, r1.error], ['confirm', 'unavailable']);
  assert.deepEqual([rows().transfers.length, rows().audit.length, rows().outbox.length], [0, 0, 0]);

  // A connection that cannot write at all.
  const r2 = await initiateTransfer(a.viewer, input, deps(a, { writer: createTransferWriter(s.transactionRo) }));
  assert.deepEqual([r2.step, r2.error], ['confirm', 'unavailable']);
  assert.ok(!JSON.stringify([r1, r2]).match(/simulated|SQLITE|readonly/i), 'the database error stays on the server');
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => /^\[transfer\] not created: unavailable \(SQLITE_[A-Z_]+\)$/.test(l)), JSON.stringify(logs));

  // Retrying with the same key after the fault is fixed creates it exactly once.
  assert.equal((await initiateTransfer(a.viewer, input, deps(a))).replayed, false);
  assert.equal((await initiateTransfer(a.viewer, input, deps(a))).replayed, true);
  assert.equal(rows().transfers.length, 1);
});

test('the transfer writer validates its own input and never creates a completed transfer', (t) => {
  const { db } = freshDb(t, 'transaction');
  const writer = createTransferWriter(db);
  const ok = { customerId: 'cus_x', senderWalletId: 'wal_a', recipientWalletId: 'wal_b', amountCents: 100, currency: 'USD', idempotencyKey: 'writer-key-00000001', balanceCents: 1000 };
  for (const change of [{ senderWalletId: 'wal_b' }, { amountCents: 0 }, { amountCents: 100_001 }, { amountCents: 1.5 }, { currency: 'EUR' }, { customerId: 'ops_x' },
    { recipientWalletId: 'mer_x' }, { idempotencyKey: 'x' }, { status: 'completed', amountCents: '100' }]) {
    assert.throws(() => writer.create({ ...ok, ...change }), (err) => err.code === 'invalid_request', JSON.stringify(change));
  }
  const { transfer } = writer.create({ ...ok, status: 'completed' });
  assert.equal(transfer.status, 'pending_risk');
  assert.equal(db.prepare('SELECT count(*) AS n FROM transfer').get().n, 1);
});

// ---------------------------------------------------------------------------
// Threat 121: request flood – per-account limit and pending-backlog limits
// ---------------------------------------------------------------------------
test('threat 121: transfer confirmations are rate-limited per account before any work is done', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  let clock = 1_000_000;
  const limiter = createTransferRateLimiter(() => clock);
  const a = await login(alice);
  const b = await login(bob);
  let balanceCalls = 0;
  const counted = (who) => deps(who, { limiter, client: 'loopback', fetchBalance: async () => { balanceCalls += 1; return { available: false }; } });
  const input = { recipientEmail: bob.email, amount: '1.00', sourceWalletId: 'wal_demo_alice', idempotencyKey: 'flood-key-000000001' };
  for (let i = 0; i < TRANSFER_LIMITS.perEmail; i += 1) {
    assert.equal((await initiateTransfer(a.viewer, input, counted(a))).error, 'banking_unavailable', `attempt ${i + 1} is processed`);
  }
  const limited = await initiateTransfer(a.viewer, input, counted(a));
  assert.deepEqual([limited.step, limited.error], ['edit', 'rate_limited']);
  assert.equal(balanceCalls, TRANSFER_LIMITS.perEmail, 'the limited attempt never reached the balance flow');
  // Another customer is not affected; the window passes.
  assert.equal((await initiateTransfer(b.viewer, { ...input, recipientEmail: alice.email, sourceWalletId: 'wal_demo_bob' }, counted(b))).error, 'banking_unavailable');
  clock += TRANSFER_LIMITS.windowMs + 1;
  assert.equal((await initiateTransfer(a.viewer, input, counted(a))).error, 'banking_unavailable');
  assert.deepEqual(rows().transfers, []);
  assert.ok(s.transactionRo);
});

test('threats 121/272/287: a pending backlog is bounded per wallet and in total, even under concurrency', async (t) => {
  const { s, rows } = await transferHarness(t);
  const base = { customerId: 'cus_demo_alice', senderWalletId: 'wal_demo_alice', recipientWalletId: 'wal_demo_bob', currency: 'USD', balanceCents: 10_000_000, amountCents: 100 };
  assert.equal(MAX_PENDING_PER_WALLET, 20);
  const small = createTransferWriter(s.transactionRw, { maxPendingPerWallet: 3, maxPendingTotal: 5 });
  for (let i = 0; i < 3; i += 1) small.create({ ...base, idempotencyKey: `backlog-key-0000${i}` });
  assert.throws(() => small.create({ ...base, idempotencyKey: 'backlog-key-00009' }), (err) => err.code === 'backlog_full');
  // A repeat of an accepted key is still answered (it adds nothing to the backlog).
  assert.equal(small.create({ ...base, idempotencyKey: 'backlog-key-00000' }).replayed, true);
  // Global limit: Bob may add two, then everyone waits.
  const bobBase = { ...base, customerId: 'cus_demo_bob', senderWalletId: 'wal_demo_bob', recipientWalletId: 'wal_demo_alice' };
  small.create({ ...bobBase, idempotencyKey: 'backlog-bob-000001' });
  small.create({ ...bobBase, idempotencyKey: 'backlog-bob-000002' });
  assert.throws(() => small.create({ ...bobBase, idempotencyKey: 'backlog-bob-000003' }), (err) => err.code === 'backlog_full');
  assert.equal(rows().transfers.length, 5);
  // Concurrent writers on separate connections cannot exceed the per-wallet limit (the default, 20).
  const results = await race(s.dataDir, Array.from({ length: 30 }, (_, i) => ({ ...base, senderWalletId: 'wal_demo_carol', customerId: 'cus_demo_carol', idempotencyKey: `backlog-race-${String(i).padStart(4, '0')}` })));
  assert.equal(results.filter((r) => r.ok).length, MAX_PENDING_PER_WALLET, JSON.stringify(results.map((r) => r.code ?? 'ok')));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'backlog_full'));
});

test('threat 121: the backlog-full and rate-limited answers keep the customer informed and write nothing', async (t) => {
  const { s, rows, deps, login } = await transferHarness(t);
  const a = await login(alice);
  const tiny = createTransferWriter(s.transactionRw, { maxPendingPerWallet: 0 });
  const review = reviewTransfer(a.viewer, { recipientEmail: bob.email, amount: '2' }, { identityDb: s.identityRo }).review;
  const r = await initiateTransfer(a.viewer, { ...review, recipientEmail: review.recipient }, deps(a, { writer: tiny }));
  assert.deepEqual([r.step, r.error, r.review?.idempotencyKey], ['confirm', 'backlog_full', review.idempotencyKey], 'kept on the confirmation: retry later with the same key');
  assert.deepEqual(rows().transfers, []);
});
