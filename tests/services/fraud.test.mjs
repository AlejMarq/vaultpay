import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { assessTransfer, engineConfig } from '../../lib/fraud/engine.js';
import { bindingOf, DECISION_TYPE, signRiskDecision, verifyRiskDecision } from '../../lib/fraud/risk-decision.js';
import { createFraudWorker, LEASE_MS, MAX_ATTEMPTS } from '../../lib/orchestrator/fraud-worker.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { createTransferWriter, pendingOutgoingCents } from '../../lib/server/transfer-orchestrator.js';
import { recentTransfers } from '../../lib/server/transfers.js';
import { mtlsRequest } from '../../lib/services/mtls-request.js';
import { loadProcessEnv } from '../../lib/services/process-env.js';
import { privateKeyFrom, publicKeyFrom } from '../../lib/services/service-token.js';
import { createFraudServer } from '../../services/fraud/app.js';
import { onCleanup } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
const T_NOW = Date.now();

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
const trf = (over = {}) => ({ id: 'trf_x', sender_wallet_id: 'wal_a', payee_type: 'wallet', payee_id: 'wal_b', amount_cents: 1250, currency: 'USD', ...over });

test('the engine is deterministic: low amounts approve, high-risk and suspicious transfers decline', () => {
  const config = engineConfig({});
  assert.equal(config.declineAtCents, 25_000);
  assert.deepEqual(assessTransfer(trf(), T_NOW, config, T_NOW), { outcome: 'approve', riskScore: 24, reasons: [] });
  assert.deepEqual(assessTransfer(trf(), T_NOW, config, T_NOW), assessTransfer(trf(), T_NOW, config, T_NOW), 'same input, same answer');
  assert.equal(assessTransfer(trf({ amount_cents: 24_999 }), T_NOW, config, T_NOW).outcome, 'approve');
  assert.deepEqual(assessTransfer(trf({ amount_cents: 25_000 }), T_NOW, config, T_NOW), { outcome: 'decline', riskScore: 900, reasons: ['amount_over_limit'] });
  assert.deepEqual(assessTransfer(trf({ payee_id: 'wal_a' }), T_NOW, config, T_NOW).reasons, ['same_wallet']);
  assert.deepEqual(assessTransfer(trf(), T_NOW + 60_000, config, T_NOW).reasons, ['implausible_time']);
  assert.deepEqual(assessTransfer(trf(), T_NOW - 2 * 86_400_000, config, T_NOW).reasons, ['implausible_time']);
  const blocked = engineConfig({ VAULTPAY_FRAUD_BLOCKED_PAYEES: 'wal_b, wal_z', VAULTPAY_FRAUD_DECLINE_AT_CENTS: '1000' });
  assert.deepEqual(assessTransfer(trf(), T_NOW, blocked, T_NOW), { outcome: 'decline', riskScore: 925, reasons: ['amount_over_limit', 'blocked_payee'] });
  for (const bad of [{ VAULTPAY_FRAUD_DECLINE_AT_CENTS: '12.5' }, { VAULTPAY_FRAUD_DECLINE_AT_CENTS: '0' }, { VAULTPAY_FRAUD_DECLINE_AT_CENTS: 'x' }, { VAULTPAY_FRAUD_BLOCKED_PAYEES: 'bob' }]) {
    assert.throws(() => engineConfig(bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Harness: a temporary installation, Fraud & Risk in-process over real mTLS, a writable
// transaction DB for the worker, and the transfer writer to create pending transfers.
// ---------------------------------------------------------------------------
async function fraudHarness(t, { engine = {} } = {}) {
  const { dataDir } = await freshInstall(t);
  const fraudEnv = loadProcessEnv('fraud', { dataDir });
  const orchestratorEnv = loadProcessEnv('orchestrator', { dataDir });
  const signingKey = privateKeyFrom(fraudEnv.values.RISK_DECISION_SIGNING_KEY);
  const keyId = fraudEnv.values.RISK_DECISION_KEY_ID;
  const publicKey = publicKeyFrom(orchestratorEnv.values.RISK_DECISION_PUBLIC_KEY);
  const serverLog = [];
  let server;
  let port;
  const startFraud = async () => {
    server = createFraudServer({ tls: fraudEnv.tls, signingKey, keyId, config: engineConfig(engine), log: (m) => serverLog.push(m) });
    port = await listen(server);
    onCleanup(t, () => (server.listening ? close(server) : undefined));
  };
  await startFraud();

  const db = openTransactionDb({ dataDir });
  const ro = openTransactionDb({ dataDir, readonly: true });
  onCleanup(t, () => { db.close(); ro.close(); });
  const writer = createTransferWriter(db);
  let offset = 0;
  const clock = { now: () => Date.now() + offset, advance: (ms) => { offset += ms; } };

  const realRequest = (body, creds = orchestratorEnv.tls) => mtlsRequest({ port, method: 'POST', path: '/v1/risk-decisions', credentials: creds, expectedServer: 'vaultpay-fraud', body, timeoutMs: 2000 });
  const logs = [];
  const worker = ({ requestDecision = (b) => realRequest(b), connection, ...rest } = {}) => createFraudWorker({
    db: connection ?? db, requestDecision, publicKey, keyId, now: clock.now, log: (m) => logs.push(m), ...rest,
  });
  let seq = 0;
  const transfer = (amountCents = 1250, from = 'wal_demo_alice', to = 'wal_demo_bob') => writer.create({
    customerId: from === 'wal_demo_alice' ? 'cus_demo_alice' : 'cus_demo_bob', senderWalletId: from, recipientWalletId: to,
    amountCents, currency: 'USD', idempotencyKey: `fraud-test-key-${(seq += 1)}-${crypto.randomBytes(4).toString('hex')}`, balanceCents: 10_000_000,
  }).transfer.transferId;
  const state = (id) => ({
    status: ro.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status,
    decisions: ro.prepare('SELECT outcome, key_version FROM risk_decision WHERE transfer_id = ?').all(id),
    audit: ro.prepare("SELECT event_type, actor_type, actor_id FROM audit_event WHERE transfer_id = ? AND event_type <> 'transfer.requested' ORDER BY rowid").all(id).map((r) => r.event_type),
    outbox: ro.prepare('SELECT target, status, attempts, last_error FROM outbox_message WHERE transfer_id = ? ORDER BY rowid').all(id),
  });
  const sign = (over) => signRiskDecision({ privateKey: signingKey, keyId, decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`, outcome: 'approve', riskScore: 10, reasons: [], ...over });
  return {
    dataDir, fraudEnv, orchestratorEnv, signingKey, keyId, publicKey, db, ro, writer, clock, worker, realRequest, transfer, state, sign, logs, serverLog,
    get server() { return server; }, startFraud, stopFraud: () => close(server),
  };
}

const rowOf = (h, id) => h.ro.prepare('SELECT * FROM transfer WHERE transfer_id = ?').get(id);

// ---------------------------------------------------------------------------
// Signed decisions
// ---------------------------------------------------------------------------
test('decisions verify only with the right key, type, request and exact transfer binding', async (t) => {
  const h = await fraudHarness(t);
  const id = h.transfer(1250);
  const expected = bindingOf(rowOf(h, id));
  const requestId = 'obx_000000000000000000000000:1';
  const ok = await h.sign({ requestId, transfer: expected });
  const v = await verifyRiskDecision(ok, { publicKey: h.publicKey, keyId: h.keyId, expected, requestId });
  assert.equal(v.outcome, 'approve');
  assert.match(v.decisionId, /^rsk_[0-9a-f]{24}$/);
  assert.equal(v.expiresAt - v.issuedAt, 600_000);

  const reject = async (jws, reason, over = {}) => assert.rejects(
    verifyRiskDecision(jws, { publicKey: h.publicKey, keyId: h.keyId, expected, requestId, ...over }),
    (err) => err.name === 'RiskDecisionError' && err.reason === reason, reason,
  );
  // Tampering with any claim breaks the signature.
  const [hd, body, sig] = ok.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  for (const edit of [{ outcome: 'decline' }, { transfer: { ...claims.transfer, amount_cents: 1 } }, { transfer: { ...claims.transfer, payee_id: 'wal_demo_carol' } }, { req: 'obx_1:9' }, { exp: claims.exp + 3600 }]) {
    await reject(`${hd}.${Buffer.from(JSON.stringify({ ...claims, ...edit })).toString('base64url')}.${sig}`, 'invalid_signature');
  }
  await reject(`${hd}.${body}.${Buffer.from('x'.repeat(64)).toString('base64url')}`, 'invalid_signature');
  await reject('', 'missing');
  await reject('a.b.c', 'invalid_signature');
  // Signed by another key: another installation's Fraud key, or Identity's service-token key.
  const other = await freshInstall(t);
  const otherKey = privateKeyFrom(loadProcessEnv('fraud', { dataDir: other.dataDir }).values.RISK_DECISION_SIGNING_KEY);
  await reject(await signRiskDecision({ privateKey: otherKey, keyId: h.keyId, decisionId: 'rsk_000000000000000000000001', requestId, transfer: expected, outcome: 'approve', riskScore: 1, reasons: [] }), 'invalid_signature');
  const tokenKey = privateKeyFrom(loadProcessEnv('identity', { dataDir: h.dataDir }).values.SERVICE_TOKEN_SIGNING_KEY);
  await reject(await signRiskDecision({ privateKey: tokenKey, keyId: h.keyId, decisionId: 'rsk_000000000000000000000002', requestId, transfer: expected, outcome: 'approve', riskScore: 1, reasons: [] }), 'invalid_signature');
  // Right key, wrong header or claims.
  const custom = (claimsOver = {}, header = {}, lifetime = 600) => {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ req: requestId, transfer: expected, outcome: 'approve', risk_score: 1, reasons: [], ...claimsOver })
      .setProtectedHeader({ alg: 'EdDSA', typ: DECISION_TYPE, kid: h.keyId, ...header })
      .setIssuer('vaultpay-fraud').setAudience('vaultpay-orchestrator').setSubject(expected.id)
      .setIssuedAt(iat).setExpirationTime(iat + lifetime).setJti('rsk_000000000000000000000003').sign(h.signingKey);
  };
  await reject(await custom({}, { typ: 'vaultpay-service+jwt' }), 'invalid_signature');
  await reject(await custom({}, { kid: 'rd-0000000000000000' }), 'unknown_key');
  await reject(await custom({}, {}, 3600), 'bad_lifetime');
  await reject(await custom({ approved_by: 'me' }), 'malformed');
  await reject(await custom({ outcome: 'maybe' }), 'malformed');
  // Expired, and issued too long ago.
  await reject(await h.sign({ requestId, transfer: expected, now: Date.now() - 700_000 }), 'expired');
  // Bound to another request or another transfer.
  await reject(ok, 'wrong_request', { requestId: 'obx_000000000000000000000000:2' });
  for (const change of [{ id: 'trf_other' }, { amount_cents: 1251 }, { payee_id: 'wal_demo_carol' }, { sender_wallet_id: 'wal_demo_bob' }, { payee_type: 'merchant' }]) {
    await reject(ok, 'wrong_transfer', { expected: { ...expected, ...change } });
  }
});

test('the Fraud & Risk service answers only the Orchestrator\'s certificate and only valid requests', async (t) => {
  const h = await fraudHarness(t);
  const id = h.transfer(1250);
  const body = { requestId: 'obx_000000000000000000000000:1', transfer: bindingOf(rowOf(h, id)), createdAt: rowOf(h, id).created_at };
  const r = await h.realRequest(body);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json), ['decision']);
  const v = await verifyRiskDecision(r.json.decision, { publicKey: h.publicKey, keyId: h.keyId, expected: body.transfer, requestId: body.requestId });
  assert.equal(v.outcome, 'approve');

  const web = loadProcessEnv('web', { dataDir: h.dataDir }).tls;
  assert.equal((await h.realRequest(body, web)).status, 403, 'Next.js (vaultpay-web) cannot ask for decisions');
  for (const bad of [{}, { ...body, extra: 1 }, { ...body, requestId: 'x' }, { ...body, transfer: { ...body.transfer, amount_cents: 12.5 } },
    { ...body, transfer: { ...body.transfer, currency: 'EUR' } }, { ...body, transfer: { ...body.transfer, payee_type: 'merchant' } }, { ...body, transfer: { ...body.transfer, outcome: 'approve' } }]) {
    const res = await h.realRequest(bad);
    assert.deepEqual([res.status, res.json], [400, { error: 'invalid_request' }], JSON.stringify(bad));
  }
  const wrongPath = await mtlsRequest({ port: h.server.address().port, method: 'POST', path: '/v1/sign', credentials: h.orchestratorEnv.tls, expectedServer: 'vaultpay-fraud', body });
  assert.equal(wrongPath.status, 404);
  // The worker pins the server identity: CBI's certificate is not Fraud & Risk.
  await assert.rejects(mtlsRequest({ port: h.server.address().port, method: 'POST', path: '/v1/risk-decisions', credentials: h.orchestratorEnv.tls, expectedServer: 'vaultpay-cbi', body }), (err) => err.code === 'bad_server');
});

// ---------------------------------------------------------------------------
// Worker: approval, decline, outbox consistency
// ---------------------------------------------------------------------------
test('the worker approves a normal transfer (→ pending_settlement) and declines a high-risk one (→ declined)', async (t) => {
  const h = await fraudHarness(t);
  const normal = h.transfer(1250);
  const risky = h.transfer(30_000);
  assert.equal(pendingOutgoingCents(h.ro, 'wal_demo_alice'), 31_250);

  const counts = await h.worker().runOnce();
  assert.deepEqual(counts, { pending_settlement: 1, declined: 1 });

  const a = h.state(normal);
  assert.equal(a.status, 'pending_settlement');
  assert.deepEqual(a.decisions, [{ outcome: 'approve', key_version: h.keyId }]);
  assert.deepEqual(a.audit, ['transfer.risk_approved']);
  assert.deepEqual(a.outbox.map((m) => [m.target, m.status]), [['fraud_check', 'done'], ['settlement', 'pending']], 'approval enqueues settlement (Step 7)');

  const d = h.state(risky);
  assert.equal(d.status, 'declined');
  assert.deepEqual(d.decisions, [{ outcome: 'decline', key_version: h.keyId }]);
  assert.deepEqual(d.audit, ['transfer.risk_declined']);
  assert.deepEqual(d.outbox.map((m) => [m.target, m.status]), [['fraud_check', 'done']], 'no settlement for a decline');

  // The stored decision is the signed JWS and still verifies against the row.
  const stored = h.ro.prepare('SELECT signature FROM risk_decision WHERE transfer_id = ?').get(normal).signature;
  const msg = h.ro.prepare("SELECT message_id, attempts FROM outbox_message WHERE transfer_id = ? AND target = 'fraud_check'").get(normal);
  await verifyRiskDecision(stored, { publicKey: h.publicKey, keyId: h.keyId, expected: bindingOf(rowOf(h, normal)), requestId: `${msg.message_id}:${msg.attempts}` });

  // Wallet views: one awaiting settlement, one declined; only the approved one is still held.
  const statuses = Object.fromEntries(recentTransfers({ transactionDb: h.ro, identityDb: { prepare: () => ({ get: () => undefined }) }, walletId: 'wal_demo_alice' }).map((x) => [x.transferId, x.status]));
  assert.deepEqual([statuses[normal], statuses[risky]], ['pending_settlement', 'declined']);
  assert.equal(pendingOutgoingCents(h.ro, 'wal_demo_alice'), 1250);
  assert.equal(h.ro.prepare("SELECT count(*) AS n FROM transfer WHERE status = 'completed'").get().n, 0);
  assert.equal(h.ro.prepare('SELECT count(*) AS n FROM ledger_entry').get().n, 0);

  assert.deepEqual(await h.worker().runOnce(), {}, 'nothing left to do');
});

test('duplicate delivery: a second fraud_check message for a screened transfer changes nothing', async (t) => {
  const h = await fraudHarness(t);
  const id = h.transfer(1250);
  await h.worker().runOnce();
  const before = h.state(id);
  h.db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('obx_dup000000000000000000000', ?, 'fraud_check', 'pending', 0, 0, ?, ?)`).run(id, Date.now(), Date.now());
  let called = 0;
  assert.deepEqual(await h.worker({ requestDecision: async (b) => { called += 1; return h.realRequest(b); } }).runOnce(), { skipped: 1 });
  assert.equal(called, 0, 'Fraud & Risk is not even asked');
  const after = h.state(id);
  assert.deepEqual([after.status, after.decisions, after.audit], [before.status, before.decisions, before.audit]);
  assert.equal(after.outbox.at(-1).status, 'done');
});

// ---------------------------------------------------------------------------
// Fail closed: tampering, replay, mismatch, expiry
// ---------------------------------------------------------------------------
test('tampered, replayed, mismatched and expired decisions are never applied', async (t) => {
  const h = await fraudHarness(t);
  const pending = (id) => {
    const s = h.state(id);
    assert.equal(s.status, 'pending_risk');
    assert.deepEqual(s.decisions, []);
    return s;
  };
  // A decision captured for transfer A (approved and applied).
  const a = h.transfer(1250);
  let captured;
  await h.worker({ requestDecision: async (b) => { const r = await h.realRequest(b); captured = r.json.decision; return r; } }).runOnce();
  assert.equal(h.state(a).status, 'pending_settlement');

  const cases = [
    // A declined high-risk transfer, with the "decline" flipped to "approve" in transit.
    ['tampered outcome', 30_000, async (b) => {
      const r = await h.realRequest(b);
      const [x, y, z] = r.json.decision.split('.');
      const c = JSON.parse(Buffer.from(y, 'base64url'));
      return { ...r, json: { decision: `${x}.${Buffer.from(JSON.stringify({ ...c, outcome: 'approve' })).toString('base64url')}.${z}` } };
    }, 'invalid_signature'],
    // Transfer A's genuine approval replayed for transfer B.
    ['replayed for another transfer', 1250, async () => ({ status: 200, json: { decision: captured } }), 'wrong_request'],
    // A genuine approval for B, but answering an earlier request id.
    ['answer to an older request', 1250, async (b) => ({ status: 200, json: { decision: await h.sign({ requestId: `${b.requestId.split(':')[0]}:0`, transfer: b.transfer }) } }), 'wrong_request'],
    // Correct request, but for different transfer details (amount).
    ['different amount', 1250, async (b) => ({ status: 200, json: { decision: await h.sign({ requestId: b.requestId, transfer: { ...b.transfer, amount_cents: 1 } }) } }), 'wrong_transfer'],
    ['different payee', 1250, async (b) => ({ status: 200, json: { decision: await h.sign({ requestId: b.requestId, transfer: { ...b.transfer, payee_id: 'wal_demo_carol' } }) } }), 'wrong_transfer'],
    ['expired', 1250, async (b) => ({ status: 200, json: { decision: await h.sign({ requestId: b.requestId, transfer: b.transfer, now: Date.now() - 700_000 }) } }), 'expired'],
    // A fresh, correctly bound decision that reuses A's decision id.
    ['reused decision id', 1250, async (b) => ({ status: 200, json: { decision: await h.sign({ requestId: b.requestId, transfer: b.transfer, decisionId: h.ro.prepare('SELECT decision_id FROM risk_decision WHERE transfer_id = ?').get(a).decision_id }) } }), 'replayed'],
    ['not a decision', 1250, async () => ({ status: 200, json: { decision: 'approved' } }), 'invalid_signature'],
    ['service down', 1250, async () => { throw Object.assign(new Error('x'), { code: 'unavailable' }); }, null],
    ['error status', 1250, async () => ({ status: 500, json: { error: 'internal_error' } }), null],
    ['200 without a decision', 1250, async () => ({ status: 200, json: { outcome: 'approve' } }), null],
  ];
  for (const [name, amount, requestDecision, reason] of cases) {
    const id = h.transfer(amount);
    const result = await h.worker({ requestDecision }).runOnce();
    assert.deepEqual(result, { retry: 1 }, name);
    const s = pending(id);
    assert.equal(s.outbox[0].status, 'pending', name);
    assert.equal(s.outbox[0].attempts, 1, name);
    if (reason) {
      assert.equal(s.outbox[0].last_error, `invalid_decision:${reason}`, name);
      assert.deepEqual(s.audit, ['risk.decision_rejected'], name);
    } else {
      assert.match(s.outbox[0].last_error, /^fraud_/, name);
      assert.deepEqual(s.audit, [], name);
    }
    // Retried later with the genuine service: screened normally, exactly once.
    h.clock.advance(2000);
    await h.worker().runOnce();
    assert.equal(h.state(id).status, amount >= 25_000 ? 'declined' : 'pending_settlement', name);
    assert.equal(h.state(id).decisions.length, 1, name);
  }
  assert.ok(!h.logs.join('\n').match(/eyJ|PRIVATE|BEGIN/), 'worker logs carry no decision or key material');
});

// ---------------------------------------------------------------------------
// Outages, retries, crash recovery, concurrency
// ---------------------------------------------------------------------------
test('Fraud & Risk unavailable: transfers stay pending_risk with backoff, and are screened once it is back', async (t) => {
  const h = await fraudHarness(t);
  const id = h.transfer(1250);
  await h.stopFraud();
  assert.deepEqual(await h.worker().runOnce(), { retry: 1 });
  let s = h.state(id);
  assert.deepEqual([s.status, s.outbox[0].status, s.outbox[0].attempts, s.outbox[0].last_error], ['pending_risk', 'pending', 1, 'fraud_unavailable']);
  assert.deepEqual(await h.worker().runOnce(), {}, 'not retried before its backoff');
  h.clock.advance(1000);
  assert.deepEqual(await h.worker().runOnce(), { retry: 1 });
  assert.equal(h.ro.prepare('SELECT next_attempt_at - updated_at AS wait FROM outbox_message WHERE transfer_id = ?').get(id).wait, 2000, 'exponential backoff');

  await h.startFraud();
  h.clock.advance(2000);
  assert.deepEqual(await h.worker().runOnce(), { pending_settlement: 1 });
  s = h.state(id);
  assert.deepEqual([s.status, s.outbox[0].status, s.outbox[0].attempts], ['pending_settlement', 'done', 3]);
});

test('after MAX_ATTEMPTS the message is dead and the transfer is still pending_risk (never approved by default)', async (t) => {
  const h = await fraudHarness(t);
  const id = h.transfer(1250);
  const down = async () => { throw Object.assign(new Error('x'), { code: 'unavailable' }); };
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    assert.deepEqual(await h.worker({ requestDecision: down }).runOnce(), i < MAX_ATTEMPTS ? { retry: 1 } : { dead: 1 });
    h.clock.advance(61_000);
  }
  const s = h.state(id);
  assert.deepEqual([s.status, s.outbox[0].status, s.decisions.length], ['pending_risk', 'dead', 0]);
  assert.deepEqual(await h.worker().runOnce(), {});
});

test('a crashed worker\'s lease expires and another run resumes; a stale worker cannot apply after losing its lease', async (t) => {
  const h = await fraudHarness(t);
  // Crash right after claiming: nothing happens until the lease runs out.
  const id = h.transfer(1250);
  const crashed = h.worker().claimNext();
  assert.equal(crashed.transferId, id);
  assert.equal(h.state(id).outbox[0].status, 'leased');
  assert.deepEqual(await h.worker().runOnce(), {}, 'a live lease is respected');
  h.clock.advance(LEASE_MS + 1);
  assert.deepEqual(await h.worker().runOnce(), { pending_settlement: 1 });
  assert.equal(h.state(id).outbox[0].attempts, 2);

  // A slow worker holds a valid decision while its lease expires and another worker
  // completes the transfer: its late apply is refused by the fencing check.
  const id2 = h.transfer(1250);
  const slowWorker = h.worker({ requestDecision: async (b) => { const r = await h.realRequest(b); await released; return r; } });
  let release;
  const released = new Promise((r) => { release = r; });
  const slowClaim = slowWorker.claimNext();
  const slow = slowWorker.process(slowClaim);
  await new Promise((r) => setTimeout(r, 200));
  h.clock.advance(LEASE_MS + 1);
  assert.deepEqual(await h.worker().runOnce(), { pending_settlement: 1 });
  release();
  assert.equal(await slow, 'lease_lost');
  const s = h.state(id2);
  assert.equal(s.decisions.length, 1, 'one decision applied');
  assert.deepEqual(s.audit, ['transfer.risk_approved']);

  // A crash inside the apply transaction (simulated database failure) rolls back everything.
  const id3 = h.transfer(1250);
  const faulty = openTransactionDb({ dataDir: h.dataDir });
  onCleanup(t, () => faulty.close());
  faulty.exec("CREATE TEMP TRIGGER fail_settlement BEFORE INSERT ON outbox_message WHEN NEW.target = 'settlement' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  assert.deepEqual(await h.worker({ connection: faulty }).runOnce(), { retry: 1 });
  let s3 = h.state(id3);
  assert.deepEqual([s3.status, s3.decisions.length, s3.audit, s3.outbox.map((m) => m.target)], ['pending_risk', 0, [], ['fraud_check']]);
  assert.match(s3.outbox[0].last_error, /^apply_failed:SQLITE_CONSTRAINT/);
  h.clock.advance(2000);
  assert.deepEqual(await h.worker().runOnce(), { pending_settlement: 1 });
  s3 = h.state(id3);
  assert.deepEqual([s3.status, s3.decisions.length, s3.outbox.map((m) => `${m.target}:${m.status}`)], ['pending_settlement', 1, ['fraud_check:done', 'settlement:pending']]);
});

test('concurrent workers on separate connections apply each decision exactly once', async (t) => {
  const h = await fraudHarness(t);
  const ids = Array.from({ length: 8 }, (_, i) => h.transfer(i % 3 === 0 ? 30_000 : 1000 + i));
  const connections = Array.from({ length: 3 }, () => openTransactionDb({ dataDir: h.dataDir }));
  onCleanup(t, () => connections.forEach((c) => c.close()));
  let calls = 0;
  const results = await Promise.all(connections.map((connection) => h.worker({ connection, requestDecision: async (b) => { calls += 1; return h.realRequest(b); } }).runOnce()));
  const total = results.reduce((acc, r) => { for (const [k, v] of Object.entries(r)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
  assert.deepEqual(total, { pending_settlement: 5, declined: 3 }, JSON.stringify(results));
  assert.equal(calls, 8, 'each transfer screened once');
  for (const id of ids) {
    const s = h.state(id);
    assert.equal(s.decisions.length, 1, id);
    assert.equal(s.audit.length, 1, id);
    assert.equal(s.outbox[0].status, 'done', id);
    assert.equal(s.outbox[0].attempts, 1, id);
  }
  assert.equal(h.ro.prepare("SELECT count(*) AS n FROM outbox_message WHERE target = 'settlement'").get().n, 5);
});
