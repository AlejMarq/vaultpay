import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPostingLookup, createReconciler } from '../../lib/orchestrator/reconciliation.js';
import { createAuditWriter } from '../../lib/server/audit.js';
import { AccessDenied } from '../../lib/server/dal.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { getOperationsOverview, ledgerIntegrityIssues } from '../../lib/server/operations.js';
import { pendingOutgoingCents } from '../../lib/server/transfer-orchestrator.js';
import { loadProcessEnv } from '../../lib/services/process-env.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup } from '../helpers/db.mjs';
import { ledgerTotals, settlementHarness } from '../helpers/settlement.mjs';

const [alice] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

async function reconHarness(t) {
  const h = await settlementHarness(t);
  const reconTls = loadProcessEnv('recon', { dataDir: h.dataDir }).tls;
  const lookupPosting = createPostingLookup({ credentials: reconTls, identityPort: h.identityPort, cbiPort: h.cbiPort, timeoutMs: 5000 });
  const recon = ({ connection, ...extra } = {}) => createReconciler({ db: connection ?? h.transactionRw, lookupPosting, now: h.clock.now, minAgeMs: 1000, ...extra });
  const audit = (id) => h.transactionRo.prepare("SELECT event_type FROM audit_event WHERE transfer_id = ? AND actor_id = 'vaultpay-recon' ORDER BY rowid").all(id).map((r) => r.event_type);
  const results = (id) => h.transactionRo.prepare('SELECT result, core_banking_ref FROM reconciliation_result WHERE transfer_id = ? ORDER BY rowid').all(id);

  /** An approved transfer whose settlement outcome is unknown and whose message is parked. */
  const ambiguous = async (amount, { posted }) => {
    const id = await h.approved(amount);
    if (posted) {
      h.bankDelay.ms = 4000; // the bank posts, its answer arrives after CBI gave up (3 s)
      assert.deepEqual(await h.settler({ maxAttempts: 1 }).runOnce(), { dead: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      h.bankDelay.ms = 0;
      assert.equal(h.postings(id).length, 1);
    } else {
      // The request never reached Settlement (so never the bank) – the worker cannot know.
      const down = async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); };
      assert.deepEqual(await h.settler({ maxAttempts: 1, requestSettlement: down }).runOnce(), { dead: 1 });
      assert.equal(h.postings(id).length, 0);
    }
    const s = h.state(id);
    assert.deepEqual([s.status, s.attempts.map((a) => a.outcome)], ['settlement_in_flight', ['unknown']]);
    return id;
  };
  return { ...h, reconTls, lookupPosting, recon, audit, results, ambiguous };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
test('bank posted but the answer was lost: reconciliation completes the transfer with exactly one ledger pair', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: true });
  assert.deepEqual(await h.recon({ minAgeMs: 60_000 }).reconcile(), {}, 'too recent: left alone');
  h.clock.advance(2000);
  assert.deepEqual(await h.recon().reconcile(), { completed: 1 });

  const s = h.state(id);
  const [posting] = h.postings(id);
  assert.equal(s.status, 'completed');
  assert.deepEqual(s.attempts.map((a) => [a.outcome, a.core_banking_ref]), [['settled', posting.posting_ref]]);
  assert.deepEqual(s.ledger.map((e) => [e.direction, e.account_id, e.amount_cents, e.core_banking_ref]), [
    ['debit', 'wal_demo_alice', 1250, posting.posting_ref], ['credit', 'wal_demo_bob', 1250, posting.posting_ref],
  ]);
  assert.deepEqual(h.results(id), [{ result: 'matched', core_banking_ref: posting.posting_ref }]);
  assert.deepEqual(h.audit(id), ['transfer.reconciled']);
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [48_750, 26_250]);
  assert.deepEqual(ledgerTotals(h), { debit_cents: 1250, credit_cents: 1250, entries: 2 });

  // Repeated runs and the settlement worker change nothing; still one posting.
  assert.deepEqual(await h.recon().reconcile(), {});
  assert.deepEqual(await h.settler().runOnce(), {});
  assert.equal(h.postings(id).length, 1);
  assert.equal(h.state(id).ledger.length, 2);
  assert.deepEqual(ledgerIntegrityIssues(h.transactionRo), []);
});

test('concurrent reconcilers on separate connections: each transfer resolved once, no duplicate ledger entries', async (t) => {
  const h = await reconHarness(t);
  const ids = [await h.ambiguous(1000, { posted: true }), await h.ambiguous(2000, { posted: true }), await h.ambiguous(3000, { posted: true })];
  h.clock.advance(2000);
  const connections = Array.from({ length: 3 }, () => openTransactionDb({ dataDir: h.dataDir }));
  onCleanup(t, () => connections.forEach((c) => c.close()));
  const runs = await Promise.all(connections.map((connection) => h.recon({ connection }).reconcile()));
  assert.equal(runs.reduce((n, r) => n + (r.completed ?? 0), 0), 3, JSON.stringify(runs));
  for (const id of ids) {
    assert.equal(h.state(id).status, 'completed');
    assert.equal(h.state(id).ledger.length, 2);
    assert.equal(h.postings(id).length, 1);
    assert.equal(h.results(id).length, 1);
  }
  assert.deepEqual(ledgerTotals(h), { debit_cents: 6000, credit_cents: 6000, entries: 6 });
});

test('no posting found is NOT proof: the transfer stays unresolved and reserved, never failed', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: false });
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 1250, 'reserved while unknown');
  h.clock.advance(10 * 60_000); // however long it has been quiet
  assert.deepEqual(await h.recon().reconcile(), { not_found: 1 });
  assert.deepEqual(await h.recon().reconcile(), { not_found: 1 });
  const s = h.state(id);
  assert.deepEqual([s.status, s.attempts.map((a) => a.outcome), s.ledger, h.postings(id)], ['settlement_in_flight', ['unknown'], [], []]);
  assert.deepEqual(h.results(id), [], 'no reconciliation decision recorded');
  assert.deepEqual(h.audit(id), ['reconciliation.unresolved', 'reconciliation.unresolved']);
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 1250, 'funds stay reserved');
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [50_000, 25_000]);
});

test('a transfer a worker holds right now (live lease) is not touched by reconciliation', async (t) => {
  const h = await reconHarness(t);
  const busy = await h.approved(500);
  const down = async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); };
  assert.deepEqual(await h.settler({ requestSettlement: down }).runOnce(), { retry: 1 });
  h.clock.advance(2000);
  h.settler().claimNext(); // claimed (leased) right now
  assert.deepEqual(await h.recon().reconcile(), { busy: 1 });
  assert.equal(h.state(busy).status, 'settlement_in_flight');
});

test('regression (Step 9): the original posting arrives AFTER a "not found" lookup – completed once, never failed, ledger and bank agree', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: false });
  const s0 = h.state(id);
  const approval = h.transactionRo.prepare('SELECT signature FROM risk_decision WHERE transfer_id = ?').get(id).signature;
  const row = h.transactionRo.prepare('SELECT * FROM transfer WHERE transfer_id = ?').get(id);
  h.clock.advance(10 * 60_000);

  // Reconciliation and the delayed original request race: the lookup sees nothing, then the
  // request (same key) reaches the bank and posts.
  let delayed;
  const racingLookup = async (req) => {
    const answer = await h.lookupPosting(req);
    delayed = h.requestSettlement({
      transfer: { id, sender_wallet_id: row.sender_wallet_id, payee_type: row.payee_type, payee_id: row.payee_id, amount_cents: row.amount_cents, currency: row.currency },
      idempotencyKey: s0.attempts[0].idempotency_key, riskDecision: approval,
    });
    await delayed;
    return answer;
  };
  assert.deepEqual(await h.recon({ lookupPosting: racingLookup }).reconcile(), { not_found: 1 });
  assert.equal((await delayed).json.outcome, 'settled', 'the late request did post');
  assert.equal(h.state(id).status, 'settlement_in_flight', 'not failed – a failed transfer would now be debited at the bank');
  assert.equal(h.bankBalance('MCB-1001'), 48_750);

  // The next pass sees the posting and completes the transfer with exactly one ledger pair.
  assert.deepEqual(await h.recon().reconcile(), { completed: 1 });
  const s = h.state(id);
  assert.deepEqual([s.status, s.ledger.length, h.postings(id).length], ['completed', 2, 1]);
  assert.equal(s.ledger[0].core_banking_ref, h.postings(id)[0].posting_ref);
  assert.deepEqual(ledgerIntegrityIssues(h.transactionRo), []);
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 0);
});

test('no transfer the bank has debited is ever left "failed": failed ⇒ no posting for its key', async (t) => {
  const h = await reconHarness(t);
  await h.ambiguous(1000, { posted: true });
  await h.ambiguous(2000, { posted: false });
  h.clock.advance(10 * 60_000);
  await h.recon().reconcile();
  const failed = h.transactionRo.prepare(`SELECT a.idempotency_key FROM transfer t JOIN settlement_attempt a ON a.transfer_id = t.transfer_id WHERE t.status = 'failed'`).all();
  for (const f of failed) assert.equal(h.bankRo.prepare('SELECT count(*) AS n FROM posting WHERE idempotency_key = ?').get(f.idempotency_key).n, 0);
  const completed = h.transactionRo.prepare("SELECT count(*) AS n FROM transfer WHERE status = 'completed'").get().n;
  assert.equal(completed, 1);
  assert.equal(h.bankRo.prepare('SELECT count(*) AS n FROM posting').get().n, completed, 'every bank posting belongs to a completed transfer');
});

test('outcome still unknown (bank path down): left unresolved and reserved, never failed', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: true });
  h.clock.advance(2000);
  await h.close(h.cbi);
  assert.deepEqual(await h.recon().reconcile(), { unresolved: 1 });
  assert.deepEqual(await h.recon().reconcile(), { unresolved: 1 });
  assert.equal(h.state(id).status, 'settlement_in_flight');
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 1250, 'funds stay reserved');
  assert.deepEqual(h.audit(id), ['reconciliation.unresolved', 'reconciliation.unresolved']);
  assert.deepEqual(h.results(id), []);

  // An answer that is not a valid result is also "unknown".
  for (const bad of [{ status: 'posted' }, { status: 'posted', postingRef: 'x' }, { status: 'gone' }, null]) {
    assert.deepEqual(await h.recon({ lookupPosting: async () => bad }).reconcile(), { unresolved: 1 }, JSON.stringify(bad));
  }
  assert.equal(h.state(id).status, 'settlement_in_flight');
});

test('a bank record that differs (amount) is flagged as an exception once and never corrected', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: false });
  const key = h.state(id).attempts[0].idempotency_key;
  h.bankDb.prepare(`INSERT INTO posting (posting_ref, idempotency_key, debit_account, credit_account, amount_cents, currency, reference, created_at)
    VALUES ('MCBP-0000000000000000beef', ?, 'MCB-1001', 'MCB-1002', 9999, 'USD', ?, ?)`).run(key, id, Date.now());
  h.clock.advance(2000);
  assert.deepEqual(await h.recon().reconcile(), { mismatch: 1 });
  assert.deepEqual(await h.recon().reconcile(), { mismatch: 1 });
  assert.equal(h.state(id).status, 'settlement_in_flight', 'left for investigation, funds reserved');
  assert.deepEqual(h.results(id), [{ result: 'mismatched', core_banking_ref: null }], 'recorded once');
  assert.deepEqual(h.audit(id), ['reconciliation.mismatch']);
  assert.equal(h.state(id).ledger.length, 0);
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
test('expiry: only overdue transfers that never reached settlement expire; reserved funds are released then', async (t) => {
  const h = await reconHarness(t);
  const inFlight = await h.ambiguous(4000, { posted: false }); // settlement attempted, outcome unknown
  const approved = await h.approved(2000); // pending_settlement, settlement message pending
  const screening = h.transfer(1000); // pending_risk, fraud_check pending
  const leased = h.transfer(3000); // pending_risk, about to be claimed by a worker
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 10_000);
  assert.equal(h.recon().expireOverdue(), 0, 'nothing is overdue yet');

  h.clock.advance(61 * 60_000);
  // A fraud worker holds `leased` right now (claims go oldest first: expire `screening` by hand first).
  h.transactionRw.prepare("UPDATE outbox_message SET next_attempt_at = next_attempt_at + 10000000 WHERE transfer_id = ? AND target = 'fraud_check'").run(screening);
  assert.equal(h.fraudWorker({ now: h.clock.now }).claimNext().transferId, leased);
  assert.equal(h.recon().expireOverdue(), 2, 'the leased one waits for the next run');
  assert.deepEqual([leased, approved, screening, inFlight].map((id) => h.state(id).status), ['pending_risk', 'expired', 'expired', 'settlement_in_flight']);
  assert.deepEqual(h.audit(approved), ['transfer.expired']);
  assert.ok(h.state(approved).outbox.every((m) => m.endsWith(':done')));
  assert.ok(h.state(screening).outbox.every((m) => m.endsWith(':done')));
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 7000, 'only the in-flight ($40) and the leased ($30) transfer stay reserved');
  const leasedId = leased;

  // The stale worker's lease is honoured; after it lapses the transfer expires too, and the
  // worker's late answer cannot apply.
  h.clock.advance(31_000);
  assert.equal(h.recon().expireOverdue(), 1);
  assert.equal(h.state(leasedId).status, 'expired');
  assert.deepEqual(await h.fraudWorker({ now: h.clock.now }).runOnce(), {});
});

test('parked messages are detected; an operator requeue retries only safe cases, with a new message', async (t) => {
  const h = await reconHarness(t);
  const id = h.transfer(1250);
  const down = async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); };
  assert.deepEqual(await h.fraudWorker({ maxAttempts: 1, requestDecision: down }).runOnce(), { dead: 1 });
  const inFlight = await h.ambiguous(500, { posted: false }); // parked settlement, in flight

  const sp = await h.verifiedLogin(support);
  const overview = getOperationsOverview(sp.viewer, { transactionDb: h.transactionRo, audit: createAuditWriter(h.transactionRw) });
  assert.deepEqual(overview.parked.map((p) => [p.transferId, p.target, p.lastError]).sort(), [[id, 'fraud_check', 'fraud_unavailable'], [inFlight, 'settlement', 'settlement_unavailable']].sort());

  assert.equal(h.recon().requeueParked(), 1, 'only the pending_risk transfer');
  assert.deepEqual(h.state(id).outbox, ['fraud_check:dead', 'fraud_check:pending']);
  assert.deepEqual(h.audit(id), ['outbox.requeued']);
  assert.equal(h.recon().requeueParked(), 0, 'not requeued twice');
  await h.fraudWorker().runOnce();
  assert.equal(h.state(id).status, 'pending_settlement');
  assert.deepEqual(h.state(inFlight).outbox, ['fraud_check:done', 'settlement:dead'], 'in-flight settlements go to reconciliation, not a new send');
});

// ---------------------------------------------------------------------------
// Ledger integrity
// ---------------------------------------------------------------------------
test('ledger integrity: a mismatch is flagged and audited, never corrected', async (t) => {
  const h = await reconHarness(t);
  const id = await h.approved(1250);
  await h.settler().runOnce();
  assert.deepEqual(h.recon().checkLedger(), []);
  // A reversal of the credit (allowed by the append-only rules) leaves the transfer unbalanced.
  const credit = h.transactionRo.prepare("SELECT entry_id FROM ledger_entry WHERE transfer_id = ? AND direction = 'credit'").get(id).entry_id;
  h.transactionRw.prepare(`INSERT INTO ledger_entry (entry_id, transfer_id, account_type, account_id, direction, amount_cents, currency, reverses_entry_id, created_at)
    VALUES ('led_reversal000000000000000', ?, 'wallet', 'wal_demo_bob', 'debit', 1250, 'USD', ?, ?)`).run(id, credit, Date.now());
  const issues = h.recon().checkLedger();
  assert.deepEqual(issues.map((i) => i.issue).sort(), ['completed_without_balanced_pair', 'ledger_totals_unbalanced']);
  assert.equal(h.transactionRo.prepare("SELECT count(*) AS n FROM audit_event WHERE event_type = 'ledger.integrity_mismatch'").get().n, 2);
  assert.equal(h.state(id).ledger.length, 3, 'nothing removed or added');
  assert.throws(() => h.transactionRw.prepare('DELETE FROM ledger_entry WHERE entry_id = ?').run(credit), /append-only/);
  assert.throws(() => h.transactionRw.prepare("UPDATE audit_event SET event_type = 'transfer.requested'").run(), /append-only/);
});

// ---------------------------------------------------------------------------
// The lookup interface
// ---------------------------------------------------------------------------
test('lookup tokens: Reconciliation only, read-only, single use; Settlement and Next.js cannot look up, Reconciliation cannot post', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: true });
  const s = h.state(id);
  const body = { transferId: id, idempotencyKey: s.attempts[0].idempotency_key, senderWalletId: 'wal_demo_alice', payeeType: 'wallet', payeeId: 'wal_demo_bob', amountCents: 1250, currency: 'USD' };
  const issue = (creds, b = body) => h.call(h.identityPort, { path: '/v1/service-tokens/reconciliation', method: 'POST', creds, body: b });
  const lookup = (token, creds = h.reconTls, extra = {}) => h.call(h.cbiPort, { path: '/v1/postings/lookup', method: 'POST', creds, headers: { authorization: `Bearer ${token}` }, ...extra });

  assert.equal((await issue(h.settlementEnv.tls)).status, 403);
  assert.equal((await issue(h.webCredentials)).status, 403);
  for (const b of [{ ...body, debitAccount: 'MCB-1003' }, { ...body, idempotencyKey: 'any' }, { ...body, amountCents: 0 }, { transferId: id }]) {
    assert.equal((await issue(h.reconTls, b)).status, 400, JSON.stringify(Object.keys(b)));
  }
  const issued = await issue(h.reconTls);
  assert.equal(issued.status, 200);
  const claims = JSON.parse(Buffer.from(issued.json.token.split('.')[1], 'base64url'));
  assert.deepEqual([claims.scope, claims.sub, claims.aud, claims.debit_account, claims.credit_account], ['corebanking.records:read', 'vaultpay-recon', 'vaultpay-cbi', 'MCB-1001', 'MCB-1002']);

  assert.equal((await lookup(issued.json.token, h.reconTls, { body: { x: 1 } })).status, 400, 'no body');
  assert.equal((await lookup(issued.json.token, h.settlementEnv.tls)).status, 403, 'Settlement cannot look up');
  assert.equal((await h.call(h.cbiPort, { path: '/v1/postings', method: 'POST', creds: h.reconTls, headers: { authorization: `Bearer ${issued.json.token}` } })).status, 403, 'Reconciliation cannot post');
  const found = await lookup(issued.json.token);
  assert.deepEqual([found.status, found.json.status, Object.keys(found.json).sort()], [200, 'posted', ['postingRef', 'status']]);
  assert.ok(!found.text.includes('MCB-1'), 'no bank account in the answer');
  assert.equal((await lookup(issued.json.token)).status, 401, 'single use');
  assert.equal(h.postings(id).length, 1, 'lookups never post');

  // Expected details that differ from the bank's record → mismatch, not "posted".
  const other = await issue(h.reconTls, { ...body, amountCents: 1251 });
  assert.equal((await lookup(other.json.token)).json.status, 'mismatch');
});

// ---------------------------------------------------------------------------
// Operations overview
// ---------------------------------------------------------------------------
test('operations overview: support only, audited before data is returned, no private details', async (t) => {
  const h = await reconHarness(t);
  const done = await h.approved(1250);
  await h.settler().runOnce();
  const unknown = await h.ambiguous(700, { posted: false });
  const writer = createAuditWriter(h.transactionRw);

  const a = await h.verifiedLogin(alice);
  assert.throws(() => getOperationsOverview(a.viewer, { transactionDb: h.transactionRo, audit: writer }), (err) => err instanceof AccessDenied && err.reason === 'wrong-role');
  const { browser } = await h.passwordLogin(support);
  const passwordOnly = await h.viewerOf(browser);
  assert.throws(() => getOperationsOverview(passwordOnly, { transactionDb: h.transactionRo, audit: writer }), (err) => err instanceof AccessDenied && err.reason === 'mfa-required');
  const sp = await h.verifiedLogin(support);
  // If the view cannot be audited, nothing is shown.
  assert.throws(() => getOperationsOverview(sp.viewer, { transactionDb: h.transactionRo, audit: createAuditWriter(h.transactionRo) }), /readonly/i);

  const views = () => h.transactionRo.prepare("SELECT count(*) AS n FROM audit_event WHERE event_type = 'support.operations_view'").get().n;
  const o = getOperationsOverview(sp.viewer, { transactionDb: h.transactionRo, audit: writer });
  assert.equal(views(), 1);
  assert.equal(o.transfersByStatus.completed, 1);
  assert.equal(o.transfersByStatus.settlement_in_flight, 1);
  assert.deepEqual(o.inFlight.map((f) => [f.transferId, f.outcome, f.messageStatus]), [[unknown, 'unknown', 'dead']]);
  assert.deepEqual(o.ledger, { debitCents: 1250, creditCents: 1250, entries: 2, balanced: true });
  assert.deepEqual(o.held, { cents: 700, transfers: 1 });
  assert.ok(o.outbox.some((m) => m.target === 'settlement' && m.status === 'dead' && m.count === 1));
  const text = JSON.stringify(o);
  for (const secret of ['MCB-', 'MCBP-', 'stlk_', 'rsk_', 'eyJ', 'wal_', 'cus_', '@example.test', 'Alice', 'Bob']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes(unknown) && !text.includes(done), 'only transfers needing attention are listed (by transfer id)');
});

test('reconciliation never posts: no lookup path can create a bank posting, with any key', async (t) => {
  const h = await reconHarness(t);
  const id = await h.ambiguous(1250, { posted: false });
  h.clock.advance(2000);
  const before = h.bankRo.prepare('SELECT count(*) AS n FROM posting').get().n;
  const keys = [];
  const spy = async (req) => { keys.push(req.idempotencyKey); return h.lookupPosting(req); };
  await h.recon({ lookupPosting: spy }).reconcile();
  assert.deepEqual(keys, [h.state(id).attempts[0].idempotency_key], 'only the attempt\'s own key is used');
  assert.equal(h.bankRo.prepare('SELECT count(*) AS n FROM posting').get().n, before);
});
