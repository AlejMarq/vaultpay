import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { signRiskDecision } from '../../lib/fraud/risk-decision.js';
import { SETTLEMENT_LEASE_MS } from '../../lib/orchestrator/settlement-worker.js';
import { fetchCustomerBalance } from '../../lib/server/balance.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { pendingOutgoingCents } from '../../lib/server/transfer-orchestrator.js';
import { recentTransfers } from '../../lib/server/transfers.js';
import { certificateThumbprint } from '../../lib/services/service-token.js';
import { DEMO_CUSTOMERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup } from '../helpers/db.mjs';
import { ledgerTotals, settlementHarness } from '../helpers/settlement.mjs';

const [alice, bob] = DEMO_CUSTOMERS;
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const totals = ledgerTotals;

// A recovery run on a heavily loaded machine may itself end "unknown" (and be retried) –
// correct behaviour. Recovery steps therefore allow a few retries and assert the end state.
async function settleUntilFinal(h, id, tries = 4) {
  for (let i = 0; i < tries && h.state(id).status === 'settlement_in_flight'; i += 1) {
    await h.settler().runOnce();
    if (h.state(id).status === 'settlement_in_flight') h.clock.advance(61_000);
  }
  return h.state(id).status;
}

// ---------------------------------------------------------------------------
// The payment
// ---------------------------------------------------------------------------
test('Alice sends $12.50 to Bob: approved, settled at the bank, ledger written – $500.00 → $487.50, $250.00 → $262.50', async (t) => {
  const h = await settlementHarness(t);
  const a = await h.verifiedLogin(alice);
  const b = await h.verifiedLogin(bob);
  const balanceOf = async (who) => (await fetchCustomerBalance(who.viewer, h.balanceDeps(who.browser))).balanceCents;
  assert.deepEqual([await balanceOf(a), await balanceOf(b)], [50_000, 25_000]);

  const id = await h.approved(1250);
  assert.deepEqual(await h.settler().runOnce(), { completed: 1 });

  const s = h.state(id);
  assert.equal(s.status, 'completed');
  const [posting] = h.postings(id);
  assert.deepEqual({ ...posting, posting_ref: typeof posting.posting_ref }, {
    posting_ref: 'string', idempotency_key: s.attempts[0].idempotency_key, debit_account: 'MCB-1001', credit_account: 'MCB-1002', amount_cents: 1250,
  });
  assert.deepEqual(s.attempts.map((x) => [x.outcome, x.core_banking_ref]), [['settled', posting.posting_ref]]);
  assert.deepEqual(s.ledger, [
    { account_type: 'wallet', account_id: 'wal_demo_alice', direction: 'debit', amount_cents: 1250, core_banking_ref: posting.posting_ref },
    { account_type: 'wallet', account_id: 'wal_demo_bob', direction: 'credit', amount_cents: 1250, core_banking_ref: posting.posting_ref },
  ]);
  assert.deepEqual(totals(h), { debit_cents: 1250, credit_cents: 1250, entries: 2 });
  assert.deepEqual(s.audit, ['transfer.requested', 'transfer.risk_approved', 'transfer.settlement_started', 'transfer.settled']);
  assert.deepEqual(s.outbox, ['fraud_check:done', 'settlement:done']);

  // The bank and the customers' own balance flow (Identity → CBI) agree.
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [48_750, 26_250]);
  assert.deepEqual([await balanceOf(a), await balanceOf(b)], [48_750, 26_250]);
  assert.equal(pendingOutgoingCents(h.transactionRo, 'wal_demo_alice'), 0, 'a completed transfer is no longer held');
  const history = recentTransfers({ transactionDb: h.transactionRo, identityDb: h.identityRo, walletId: 'wal_demo_bob' });
  assert.deepEqual([history[0].transferId, history[0].direction, history[0].status], [id, 'received', 'completed']);
  assert.ok(!JSON.stringify(history).match(/MCB|stlk_|rsk_/), 'no bank account, posting key or decision in the wallet view');

  // Ledger and audit stay append-only.
  assert.throws(() => h.transactionRw.prepare('UPDATE ledger_entry SET amount_cents = 1').run(), /append-only/);
  assert.throws(() => h.transactionRw.prepare('DELETE FROM ledger_entry').run(), /append-only/);
  assert.throws(() => h.transactionRw.prepare("UPDATE transfer SET status = 'failed' WHERE transfer_id = ?").run(id), /invalid transfer status transition|fails only/);
  assert.throws(() => h.bankDb.prepare('DELETE FROM posting').run(), /append-only/);

  // Nothing more to do; a duplicate settlement message is skipped without a second posting.
  assert.deepEqual(await h.settler().runOnce(), {});
  h.transactionRw.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('obx_dupsettle00000000000000', ?, 'settlement', 'pending', 0, 0, ?, ?)`).run(id, Date.now(), Date.now());
  assert.deepEqual(await h.settler().runOnce(), { skipped: 1 });
  assert.equal(h.postings(id).length, 1);
  assert.ok(!h.logs.join('\n').match(/MCB-|eyJ|PRIVATE/), 'worker logs carry no account, token or key');
  assert.ok(!h.settlementLog.join('\n').match(/eyJ|PRIVATE/), 'Settlement logs carry no token or key');
});

// ---------------------------------------------------------------------------
// The bank decides
// ---------------------------------------------------------------------------
test('bank-side insufficient funds and account restrictions fail the transfer; nothing moves', async (t) => {
  const h = await settlementHarness(t, { engine: { VAULTPAY_FRAUD_DECLINE_AT_CENTS: '1000000' } });
  // $600.00 passes fraud and the (bypassed) preliminary check, but Alice has $500.00 at the bank.
  const big = await h.approved(60_000);
  assert.deepEqual(await h.settler().runOnce(), { failed: 1 });
  let s = h.state(big);
  assert.deepEqual([s.status, s.attempts.map((x) => x.outcome), s.ledger, h.postings(big)], ['failed', ['failed'], [], []]);
  assert.deepEqual(s.audit.slice(-1), ['transfer.settlement_failed']);

  // The bank account is frozen at the bank (VaultPay's wallet is still active).
  h.bankDb.prepare("UPDATE account SET status = 'frozen' WHERE account_ref = 'MCB-1002'").run();
  const toFrozen = await h.approved(1000);
  assert.deepEqual(await h.settler().runOnce(), { failed: 1 });
  h.bankDb.prepare("UPDATE account SET status = 'active' WHERE account_ref = 'MCB-1002'").run();
  assert.equal(h.state(toFrozen).status, 'failed');

  // VaultPay's own wallet frozen after approval: Identity issues no settlement token.
  const toFrozenWallet = await h.approved(1000);
  h.identityDb.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_bob'").run();
  assert.deepEqual(await h.settler().runOnce(), { failed: 1 });
  h.identityDb.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_bob'").run();
  s = h.state(toFrozenWallet);
  assert.deepEqual([s.status, h.postings(toFrozenWallet).length], ['failed', 0]);

  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [50_000, 25_000], 'no money moved');
  assert.deepEqual(totals(h), { debit_cents: 0, credit_cents: 0, entries: 0 });
});

test('regression (Step 9): a bank refusal after an earlier unanswered send is not final – no "failed" that the bank could still debit', async (t) => {
  const h = await settlementHarness(t);
  const id = await h.approved(1250);
  const down = async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); };
  assert.deepEqual(await h.settler({ requestSettlement: down }).runOnce(), { retry: 1 }); // first send: no answer
  h.bankDb.prepare("UPDATE account SET balance_cents = 100 WHERE account_ref = 'MCB-1001'").run(); // the retry is refused
  h.clock.advance(2000);
  assert.deepEqual(await h.settler().runOnce(), { retry: 1 });
  let s = h.state(id);
  assert.deepEqual([s.status, s.attempts.map((a) => a.outcome)], ['settlement_in_flight', ['unknown']], 'kept in flight, funds reserved');
  // The earlier request could still post; when funds allow, the same key settles it exactly once.
  h.bankDb.prepare("UPDATE account SET balance_cents = 50000 WHERE account_ref = 'MCB-1001'").run();
  h.clock.advance(4000);
  assert.deepEqual(await h.settler().runOnce(), { completed: 1 });
  s = h.state(id);
  assert.deepEqual([s.status, h.postings(id).length, s.ledger.length], ['completed', 1, 2]);
});

// ---------------------------------------------------------------------------
// Ambiguous outcomes, crashes, concurrency
// ---------------------------------------------------------------------------
test('bank timeout AFTER posting: outcome unknown, retried with the same key, money moved exactly once', async (t) => {
  const h = await settlementHarness(t);
  const id = await h.approved(1250);
  h.bankDelay.ms = 4000; // CBI gives the bank 3 s: it times out although the posting committed
  assert.deepEqual(await h.settler().runOnce(), { retry: 1 });
  let s = h.state(id);
  assert.deepEqual([s.status, s.attempts.map((x) => x.outcome), s.ledger.length], ['settlement_in_flight', ['unknown'], 0]);
  assert.ok(s.audit.includes('transfer.settlement_unknown'));
  assert.equal(h.postings(id).length, 1, 'the bank did post');
  assert.equal(h.bankBalance('MCB-1001'), 48_750);

  await new Promise((r) => setTimeout(r, 1500)); // let the delayed answer finish
  h.bankDelay.ms = 0;
  h.clock.advance(2000);
  assert.equal(await settleUntilFinal(h, id), 'completed');
  s = h.state(id);
  assert.deepEqual([s.status, s.attempts.length, s.attempts[0].outcome], ['completed', 1, 'settled']);
  assert.equal(h.postings(id).length, 1, 'same idempotency key: no second posting');
  assert.equal(s.ledger[0].core_banking_ref, h.postings(id)[0].posting_ref);
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [48_750, 26_250]);
});

test('a worker that crashes before or after the bank call is recovered by another run, without a second posting', async (t) => {
  const h = await settlementHarness(t);
  const hang = () => new Promise(() => {});
  // (1) Crash after the attempt was recorded, before anything was sent.
  const before = await h.approved(1000);
  void h.settler({ requestSettlement: hang }).runOnce();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([h.state(before).status, h.state(before).attempts.map((x) => x.outcome)], ['settlement_in_flight', ['pending']]);
  assert.deepEqual(await h.settler().runOnce(), {}, 'the lease is still held');
  h.clock.advance(SETTLEMENT_LEASE_MS + 1);
  assert.equal(await settleUntilFinal(h, before), 'completed');
  assert.equal(h.postings(before).length, 1);

  // (2) Crash after the bank posted, before the result was recorded.
  const after = await h.approved(2000);
  void h.settler({ requestSettlement: async (body) => { await h.requestSettlement(body); return hang(); } }).runOnce();
  for (let i = 0; i < 50 && h.postings(after).length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.postings(after).length, 1);
  assert.equal(h.state(after).status, 'settlement_in_flight');
  h.clock.advance(SETTLEMENT_LEASE_MS + 1);
  assert.equal(await settleUntilFinal(h, after), 'completed');
  assert.equal(h.postings(after).length, 1, 'the retry found the original posting');
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [47_000, 28_000]);
  assert.deepEqual(totals(h), { debit_cents: 3000, credit_cents: 3000, entries: 4 });
});

test('concurrent settlement workers on separate connections settle each transfer exactly once', async (t) => {
  const h = await settlementHarness(t);
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(h.transfer(500 + i));
  await h.fraudWorker().runOnce();
  const connections = Array.from({ length: 3 }, () => openTransactionDb({ dataDir: h.dataDir }));
  onCleanup(t, () => connections.forEach((c) => c.close()));
  const results = await Promise.all(connections.map((connection) => h.settler({ connection }).runOnce()));
  const completed = results.reduce((n, r) => n + (r.completed ?? 0), 0);
  assert.equal(completed, 6, JSON.stringify(results));
  for (const id of ids) {
    assert.equal(h.state(id).status, 'completed');
    assert.equal(h.postings(id).length, 1);
    assert.equal(h.state(id).ledger.length, 2);
  }
  const sum = ids.reduce((n, _, i) => n + 500 + i, 0);
  assert.deepEqual([h.bankBalance('MCB-1001'), h.bankBalance('MCB-1002')], [50_000 - sum, 25_000 + sum]);
  assert.deepEqual(totals(h), { debit_cents: sum, credit_cents: sum, entries: 12 });
});

test('Settlement or CBI unavailable: the transfer stays in flight and completes later with the same key', async (t) => {
  const h = await settlementHarness(t);
  const id = await h.approved(1250);
  await h.close(h.cbi);
  assert.deepEqual(await h.settler().runOnce(), { retry: 1 });
  const s = h.state(id);
  assert.deepEqual([s.status, s.attempts.map((x) => x.outcome)], ['settlement_in_flight', ['unknown']]);
  assert.equal(h.postings(id).length, 0);
  const key = s.attempts[0].idempotency_key;
  // A worker that cannot reach Settlement at all: also retried, never failed.
  h.clock.advance(2000);
  assert.deepEqual(await h.settler({ requestSettlement: async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); } }).runOnce(), { retry: 1 });
  assert.equal(h.state(id).status, 'settlement_in_flight');
  assert.equal(h.state(id).attempts[0].idempotency_key, key, 'the same key is kept');

  // Still unknown when the approval expires: the key cannot be resubmitted, so the message is
  // parked for reconciliation – the transfer is neither completed nor failed by guesswork.
  h.clock.advance(11 * 60_000);
  assert.deepEqual(await h.settler().runOnce(), { dead: 1 });
  const parked = h.transactionRo.prepare("SELECT status, last_error FROM outbox_message WHERE transfer_id = ? AND target = 'settlement'").get(id);
  assert.deepEqual([h.state(id).status, parked.status, parked.last_error], ['settlement_in_flight', 'dead', 'needs_reconciliation']);
});

// ---------------------------------------------------------------------------
// Fraud approvals
// ---------------------------------------------------------------------------
test('an expiring or expired fraud approval sends the transfer back to screening; re-approved, it settles', async (t) => {
  const h = await settlementHarness(t);
  // (1) Less than the required minute of validity left (simulated with a 10-minute margin).
  const id = await h.approved(1250);
  assert.deepEqual(await h.settler({ minApprovalRemainingMs: 10 * 60_000 }).runOnce(), { rescreened: 1 });
  let s = h.state(id);
  assert.deepEqual([s.status, s.attempts.length, h.postings(id).length], ['pending_risk', 0, 0]);
  assert.deepEqual(s.outbox, ['fraud_check:done', 'settlement:done', 'fraud_check:pending']);
  assert.ok(s.audit.includes('transfer.risk_rescreen'));
  await h.fraudWorker().runOnce();
  assert.equal(h.state(id).status, 'pending_settlement');
  assert.deepEqual(await h.settler().runOnce(), { completed: 1 });
  assert.equal(h.transactionRo.prepare('SELECT count(*) AS n FROM risk_decision WHERE transfer_id = ?').get(id).n, 2);

  // (2) A genuinely expired approval (signed 11 minutes ago) as the latest decision.
  const old = await h.approved(500);
  const row = h.transactionRo.prepare('SELECT * FROM transfer WHERE transfer_id = ?').get(old);
  const expired = await signRiskDecision({
    privateKey: h.riskSigningKey, keyId: h.riskKeyId, decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`, requestId: 'x',
    transfer: { id: old, sender_wallet_id: row.sender_wallet_id, payee_type: row.payee_type, payee_id: row.payee_id, amount_cents: row.amount_cents, currency: row.currency },
    outcome: 'approve', riskScore: 1, reasons: [], now: Date.now() - 660_000,
  });
  h.transactionRw.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES ('rsk_expired000000000000000000', ?, 'approve', 1, ?, ?, ?, ?, ?)`).run(old, expired, h.riskKeyId, Date.now() - 660_000, Date.now() - 60_000, Date.now() + 5);
  assert.deepEqual(await h.settler().runOnce(), { rescreened: 1 });
  s = h.state(old);
  assert.deepEqual([s.status, h.postings(old).length], ['pending_risk', 0]);
});

test('a stored approval that no longer verifies (tampered) is never settled', async (t) => {
  const h = await settlementHarness(t);
  const id = await h.approved(1250);
  // Swap in an approval for a different amount, genuinely signed: the binding check fails.
  const forged = await signRiskDecision({
    privateKey: h.riskSigningKey, keyId: h.riskKeyId, decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`, requestId: 'x',
    transfer: { id, sender_wallet_id: 'wal_demo_alice', payee_type: 'wallet', payee_id: 'wal_demo_bob', amount_cents: 99_999, currency: 'USD' },
    outcome: 'approve', riskScore: 1, reasons: [],
  });
  h.transactionRw.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES ('rsk_forged0000000000000000000', ?, 'approve', 1, ?, ?, ?, ?, ?)`).run(id, forged, h.riskKeyId, Date.now(), Date.now() + 600_000, Date.now() + 5);
  assert.deepEqual(await h.settler().runOnce(), { rescreened: 1 });
  assert.deepEqual([h.state(id).status, h.postings(id).length], ['pending_risk', 0]);
});

// ---------------------------------------------------------------------------
// Settlement tokens: Identity issuance and CBI acceptance
// ---------------------------------------------------------------------------
test('settlement tokens: purpose-bound at Identity; tampered, expired, wrong-scope, misbound and replayed tokens refused at CBI', async (t) => {
  const h = await settlementHarness(t);
  const id = await h.approved(1250);
  const approval = h.transactionRo.prepare('SELECT signature FROM risk_decision WHERE transfer_id = ?').get(id).signature;
  const key = `stlk_${crypto.randomBytes(12).toString('hex')}`;
  const settlementCreds = h.settlementEnv.tls;
  const issue = (body, creds = settlementCreds) => h.call(h.identityPort, { path: '/v1/service-tokens/settlement', method: 'POST', creds, body });
  const post = (token, { creds = settlementCreds, body } = {}) => h.call(h.cbiPort, { path: '/v1/postings', method: 'POST', creds, body, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  // Identity: only Settlement, only for a genuine unexpired approval, and only those two fields.
  const issued = await issue({ riskDecision: approval, idempotencyKey: key });
  assert.equal(issued.status, 200);
  const claims = JSON.parse(Buffer.from(issued.json.token.split('.')[1], 'base64url'));
  assert.deepEqual({ ...claims, iat: 0, exp: 0, jti: 0, cnf: 0, decision_id: 0 }, {
    transfer_id: id, debit_account: 'MCB-1001', credit_account: 'MCB-1002', amount_cents: 1250, currency: 'USD', idempotency_key: key,
    scope: 'corebanking.settlement:submit', iss: 'vaultpay-identity', aud: 'vaultpay-cbi', sub: 'vaultpay-settlement', iat: 0, exp: 0, jti: 0, cnf: 0, decision_id: 0,
  });
  assert.equal(claims.exp - claims.iat, 30);
  assert.equal((await issue({ riskDecision: approval, idempotencyKey: key }, h.webCredentials)).status, 403, 'Next.js cannot get settlement tokens');
  assert.equal((await h.call(h.identityPort, { path: '/v1/service-tokens/customer-balance', method: 'POST', creds: settlementCreds, body: { sessionToken: 'x'.repeat(32) } })).status, 403, 'Settlement cannot get balance tokens');
  for (const body of [{ riskDecision: approval }, { riskDecision: approval, idempotencyKey: key, debitAccount: 'MCB-1003' }, { riskDecision: approval, idempotencyKey: 'any-key-1234' }, { riskDecision: approval, idempotencyKey: key, scope: 'x' }]) {
    assert.equal((await issue(body)).status, 400, JSON.stringify(Object.keys(body)));
  }
  const [hd, pl, sg] = approval.split('.');
  const tamperedApproval = `${hd}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, 'base64url')), transfer: { ...JSON.parse(Buffer.from(pl, 'base64url')).transfer, payee_id: 'wal_demo_carol' } })).toString('base64url')}.${sg}`;
  const decline = await signRiskDecision({ privateKey: h.riskSigningKey, keyId: h.riskKeyId, decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`, requestId: 'x', transfer: JSON.parse(Buffer.from(pl, 'base64url')).transfer, outcome: 'decline', riskScore: 900, reasons: ['amount_over_limit'] });
  const stale = await signRiskDecision({ privateKey: h.riskSigningKey, keyId: h.riskKeyId, decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`, requestId: 'x', transfer: JSON.parse(Buffer.from(pl, 'base64url')).transfer, outcome: 'approve', riskScore: 1, reasons: [], now: Date.now() - 700_000 });
  for (const riskDecision of [tamperedApproval, decline, stale, 'not.a.jws']) {
    assert.equal((await issue({ riskDecision, idempotencyKey: key })).status, 403);
  }

  // CBI: no body, the right caller, the right scope, once.
  assert.equal((await post(issued.json.token, { body: { amountCents: 1 } })).status, 400, 'a body is refused – details come only from the token');
  assert.equal((await post(issued.json.token, { creds: h.webCredentials })).status, 403, 'Next.js cannot post');
  const [th, tp, ts] = issued.json.token.split('.');
  const edited = `${th}.${Buffer.from(JSON.stringify({ ...claims, amount_cents: 99_999 })).toString('base64url')}.${ts}`;
  assert.equal((await post(edited)).status, 401, 'tampered amount');
  const forge = (over = {}, { iat = Math.floor(Date.now() / 1000), cert = settlementCreds.cert } = {}) => new SignJWT({ ...claims, cnf: { 'x5t#S256': certificateThumbprint(new crypto.X509Certificate(cert).raw) }, ...over })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'vaultpay-service+jwt', kid: h.keyId })
    .setIssuedAt(iat).setExpirationTime(iat + 30).setJti(crypto.randomBytes(16).toString('base64url')).sign(h.signingKey);
  assert.equal((await post(await forge({}, { iat: Math.floor(Date.now() / 1000) - 120 }))).status, 401, 'expired');
  assert.equal((await post(await forge({ scope: 'corebanking.balance:read' }))).status, 403, 'wrong scope');
  assert.equal((await post(await forge({}, { cert: h.webCredentials.cert }))).status, 401, 'bound to another certificate');
  assert.equal((await post(await forge({ aud: 'vaultpay-bank' }))).status, 401, 'wrong audience');
  assert.equal((await post(await forge({ debit_account: 'MCB-1002' }))).status, 403, 'same debit and credit account');
  assert.equal((await h.call(h.cbiPort, { path: '/v1/balance', creds: settlementCreds, headers: { authorization: `Bearer ${await forge()}` } })).status, 403, 'a settlement token cannot read balances');
  assert.equal(h.postings(id).length, 0, 'none of these reached the bank');

  const first = await post(issued.json.token);
  assert.deepEqual([first.status, first.json.outcome], [200, 'posted']);
  const replay = await post(issued.json.token);
  assert.equal(replay.status, 401, 'single use');
  assert.equal(h.postings(id).length, 1);
  assert.ok(!`${first.text}${replay.text}`.match(/MCB-1|stlk_|eyJ/), 'CBI returns only the posting reference');
  assert.equal(tp.length > 0, true);
});
