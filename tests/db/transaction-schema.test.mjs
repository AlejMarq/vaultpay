import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertRejected, freshDb, T0 } from '../helpers/db.mjs';

// ---------------------------------------------------------------------------
// Small builders – each returns the id it inserted
// ---------------------------------------------------------------------------
function insertTransfer(db, overrides = {}) {
  const row = {
    transfer_id: `trf_${Math.random().toString(36).slice(2)}`,
    sender_wallet_id: 'wal_alice',
    payee_type: 'wallet',
    payee_id: 'wal_bob',
    amount_cents: 1250,
    idempotency_key: `idem-${Math.random().toString(36).slice(2)}`,
    status: 'pending_risk',
    pending_expires_at: T0 + 600_000,
    settlement_attempted_at: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
  db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents,
      idempotency_key, status, pending_expires_at, settlement_attempted_at, created_at, updated_at)
    VALUES (@transfer_id, @sender_wallet_id, @payee_type, @payee_id, @amount_cents,
      @idempotency_key, @status, @pending_expires_at, @settlement_attempted_at, @created_at, @updated_at)`).run(row);
  return row.transfer_id;
}

const setStatus = (db, id, status, extra = '') =>
  db.prepare(`UPDATE transfer SET status = ?, updated_at = updated_at + 1 ${extra} WHERE transfer_id = ?`).run(status, id);

function insertDecision(db, transferId, outcome = 'approve', id = `rsk_${Math.random().toString(36).slice(2)}`) {
  db.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES (?, ?, ?, 120, 'eyJhbGciOiJFZERTQSJ9.payload.sig', 'v1', ?, ?, ?)`).run(id, transferId, outcome, T0, T0 + 60_000, T0);
  return id;
}

// Moves a transfer to settlement_in_flight the way the Orchestrator will (D5 order).
function sendToSettlement(db, transferId) {
  setStatus(db, transferId, 'pending_settlement');
  const decisionId = insertDecision(db, transferId);
  setStatus(db, transferId, 'settlement_in_flight', `, settlement_attempted_at = ${T0 + 10}`);
  return decisionId;
}

function insertAttempt(db, transferId, decisionId, overrides = {}) {
  const row = {
    attempt_id: `stl_${Math.random().toString(36).slice(2)}`,
    attempt_no: 1,
    idempotency_key: `cbk-${Math.random().toString(36).slice(2)}`,
    outcome: 'pending',
    ...overrides,
  };
  db.prepare(`INSERT INTO settlement_attempt (attempt_id, transfer_id, decision_id, attempt_no, idempotency_key, requested_at, outcome)
    VALUES (@attempt_id, @transfer_id, @decision_id, @attempt_no, @idempotency_key, ${T0 + 10}, @outcome)`)
    .run({ ...row, transfer_id: transferId, decision_id: decisionId });
  return row.attempt_id;
}

function completedTransfer(db, overrides) {
  const id = insertTransfer(db, overrides);
  const decisionId = sendToSettlement(db, id);
  const attemptId = insertAttempt(db, id, decisionId);
  db.prepare(`UPDATE settlement_attempt SET outcome = 'settled', core_banking_ref = 'cb-1', completed_at = ${T0 + 20} WHERE attempt_id = ?`).run(attemptId);
  setStatus(db, id, 'completed');
  return id;
}

// Since v5 a posting carries its bank posting reference (completedTransfer settles as 'cb-1').
function post(db, transferId, { id = `led_${Math.random().toString(36).slice(2)}`, type = 'wallet', account, direction, amount = 1250, reverses = null, ref = 'cb-1' }) {
  db.prepare(`INSERT INTO ledger_entry (entry_id, transfer_id, account_type, account_id, direction, amount_cents, reverses_entry_id, core_banking_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, transferId, type, account, direction, amount, reverses, ref, T0 + 30);
  return id;
}

// ---------------------------------------------------------------------------
// Transfers – validation and idempotency
// ---------------------------------------------------------------------------
test('transfer: idempotency key is unique per sender, not globally', (t) => {
  const { db } = freshDb(t, 'transaction');
  insertTransfer(db, { idempotency_key: 'same-key-123' });
  assertRejected(() => insertTransfer(db, { idempotency_key: 'same-key-123' }), 'UNIQUE');
  insertTransfer(db, { idempotency_key: 'same-key-123', sender_wallet_id: 'wal_carol', payee_id: 'wal_bob' });
});

test('transfer: amounts must be whole positive cents within the limit', (t) => {
  const { db } = freshDb(t, 'transaction');
  for (const amount_cents of [0, -1, 1_000_001]) assertRejected(() => insertTransfer(db, { amount_cents }), 'CHECK');
  assertRejected(() => insertTransfer(db, { amount_cents: 12.5 }), 'cannot store REAL');
  insertTransfer(db, { amount_cents: 1 });
  insertTransfer(db, { amount_cents: 1_000_000 });
});

test('transfer: payee must be well-formed and not the sender', (t) => {
  const { db } = freshDb(t, 'transaction');
  assertRejected(() => insertTransfer(db, { payee_id: 'wal_alice' }), 'CHECK');
  assertRejected(() => insertTransfer(db, { payee_type: 'merchant', payee_id: 'wal_bob' }), 'CHECK');
  assertRejected(() => insertTransfer(db, { payee_type: 'bank' }), 'CHECK');
  assertRejected(() => insertTransfer(db, { sender_wallet_id: 'alice' }), 'CHECK');
  assertRejected(() => insertTransfer(db, { idempotency_key: 'short' }), 'CHECK');
  insertTransfer(db, { payee_type: 'merchant', payee_id: 'mer_coffee' });
});

test('transfer: must start pending_risk with no settlement attempt', (t) => {
  const { db } = freshDb(t, 'transaction');
  assertRejected(() => insertTransfer(db, { status: 'completed', settlement_attempted_at: T0 }), 'must start as pending_risk');
  assertRejected(() => insertTransfer(db, { status: 'unknown_status' }), 'must start as pending_risk');
  assertRejected(() => insertTransfer(db, { pending_expires_at: null }), 'CHECK');
});

test('transfer: parties, amount and idempotency key cannot change; rows cannot be deleted', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  for (const set of ["amount_cents = 1", "payee_id = 'wal_mallory'", "sender_wallet_id = 'wal_mallory'", "idempotency_key = 'other-key-1'"]) {
    assertRejected(() => db.prepare(`UPDATE transfer SET ${set} WHERE transfer_id = ?`).run(id), 'cannot change');
  }
  assertRejected(() => db.prepare('DELETE FROM transfer WHERE transfer_id = ?').run(id), 'cannot be deleted');
});

test('transfer: the full happy path is allowed', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db);
  assert.equal(db.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status, 'completed');
});

test('transfer: invalid status transitions are blocked', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  assertRejected(() => setStatus(db, id, 'completed', `, settlement_attempted_at = ${T0}`)); // transition and v5 settlement triggers
  assertRejected(() => setStatus(db, id, 'settlement_in_flight', `, settlement_attempted_at = ${T0}`), 'invalid transfer status transition');

  const done = completedTransfer(db);
  for (const status of ['pending_risk', 'pending_settlement', 'failed']) {
    assertRejected(() => setStatus(db, done, status));
  }
  const declined = insertTransfer(db);
  setStatus(db, declined, 'declined');
  assertRejected(() => setStatus(db, declined, 'pending_settlement'), 'invalid transfer status transition');
});

test('transfer (D5): cannot be sent to settlement without recording the attempt', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  setStatus(db, id, 'pending_settlement');
  assertRejected(() => setStatus(db, id, 'settlement_in_flight'), 'CHECK');
});

test('transfer (D5): never expires or re-screens once settlement was attempted', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  setStatus(db, id, 'pending_settlement');
  db.prepare(`UPDATE transfer SET settlement_attempted_at = ${T0 + 5} WHERE transfer_id = ?`).run(id);
  assertRejected(() => setStatus(db, id, 'expired'), 'CHECK');
  assertRejected(() => setStatus(db, id, 'pending_risk'), 'CHECK');
  assertRejected(() => db.prepare('UPDATE transfer SET settlement_attempted_at = NULL WHERE transfer_id = ?').run(id), 'cannot be changed once recorded');

  setStatus(db, id, 'settlement_in_flight');
  assertRejected(() => setStatus(db, id, 'expired'));

  // before an attempt, expiry and re-screening are allowed
  const early = insertTransfer(db);
  setStatus(db, early, 'pending_settlement');
  setStatus(db, early, 'pending_risk');
  setStatus(db, early, 'expired');
});

// ---------------------------------------------------------------------------
// Ledger – append-only, postings tied to completed transfers
// ---------------------------------------------------------------------------
test('ledger: postings are only allowed for completed transfers and must match them', (t) => {
  const { db } = freshDb(t, 'transaction');
  const pending = insertTransfer(db);
  assertRejected(() => post(db, pending, { account: 'wal_alice', direction: 'debit' })); // not completed, no settled posting

  const id = completedTransfer(db);
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit', amount: 9999 }), 'does not match');
  assertRejected(() => post(db, id, { account: 'wal_bob', direction: 'debit' }), 'does not match');
  post(db, id, { account: 'wal_alice', direction: 'debit' });
  assertRejected(() => post(db, id, { account: 'wal_mallory', direction: 'credit' }), 'does not match');
  post(db, id, { account: 'wal_bob', direction: 'credit' });
});

test('ledger: merchant payments credit the merchant account', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db, { payee_type: 'merchant', payee_id: 'mer_coffee' });
  post(db, id, { account: 'wal_alice', direction: 'debit' });
  assertRejected(() => post(db, id, { type: 'wallet', account: 'wal_coffee', direction: 'credit' }));
  post(db, id, { type: 'merchant', account: 'mer_coffee', direction: 'credit' });
});

test('ledger (v5): double entry tied to the bank posting; completion and failure need settlement attempts', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db);
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit', ref: 'cb-other' }), 'settled bank posting');
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit', ref: null }), 'settled bank posting');
  assertRejected(() => post(db, id, { account: 'wal_bob', direction: 'credit' }), 'matching debit first');
  post(db, id, { account: 'wal_alice', direction: 'debit' });
  post(db, id, { account: 'wal_bob', direction: 'credit' });
  assert.deepEqual(db.prepare('SELECT debit_cents, credit_cents, entries FROM ledger_totals').get(), { debit_cents: 1250, credit_cents: 1250, entries: 2 });

  // A completed transfer's settlement message cannot be finished without both entries.
  const half = completedTransfer(db);
  db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('obx_half', ?, 'settlement', 'pending', 0, ${T0}, ${T0}, ${T0})`).run(half);
  post(db, half, { account: 'wal_alice', direction: 'debit' });
  assertRejected(() => db.prepare(`UPDATE outbox_message SET status = 'done', updated_at = ${T0 + 1} WHERE message_id = 'obx_half'`).run(), 'balanced debit and credit');
  post(db, half, { account: 'wal_bob', direction: 'credit' });
  db.prepare(`UPDATE outbox_message SET status = 'done', updated_at = ${T0 + 1} WHERE message_id = 'obx_half'`).run();

  // In flight with only a pending attempt: neither completed nor failed.
  const open = insertTransfer(db);
  const decisionId = sendToSettlement(db, open);
  const attempt = insertAttempt(db, open, decisionId);
  assertRejected(() => setStatus(db, open, 'completed'), 'only after a settled bank posting');
  assertRejected(() => setStatus(db, open, 'failed'), 'fails only after');
  db.prepare("UPDATE settlement_attempt SET outcome = 'unknown' WHERE attempt_id = ?").run(attempt);
  assertRejected(() => setStatus(db, open, 'failed'), 'fails only after');
  db.prepare(`UPDATE settlement_attempt SET outcome = 'failed', completed_at = ${T0 + 20} WHERE attempt_id = ?`).run(attempt);
  setStatus(db, open, 'failed');
});

test('ledger: a transfer cannot be posted twice', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db);
  post(db, id, { account: 'wal_alice', direction: 'debit' });
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit' }), 'UNIQUE');
});

test('ledger: entries cannot be updated or deleted', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db);
  const entry = post(db, id, { account: 'wal_alice', direction: 'debit' });
  assertRejected(() => db.prepare('UPDATE ledger_entry SET amount_cents = 1 WHERE entry_id = ?').run(entry), 'ledger is append-only');
  assertRejected(() => db.prepare('DELETE FROM ledger_entry WHERE entry_id = ?').run(entry), 'ledger is append-only');
  assertRejected(() => db.prepare('DELETE FROM ledger_entry').run(), 'ledger is append-only');
});

test('ledger: corrections are exact mirror reversals, at most once', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = completedTransfer(db);
  const debit = post(db, id, { account: 'wal_alice', direction: 'debit' });

  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit', reverses: debit }), 'mirror');
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'credit', amount: 1, reverses: debit }), 'mirror');
  assertRejected(() => post(db, id, { account: 'wal_bob', direction: 'credit', reverses: debit }), 'mirror');
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'credit', reverses: 'led_nope' }));

  const reversal = post(db, id, { account: 'wal_alice', direction: 'credit', reverses: debit });
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'credit', reverses: debit }), 'UNIQUE');
  assertRejected(() => post(db, id, { account: 'wal_alice', direction: 'debit', reverses: reversal }), 'mirror');
});

// ---------------------------------------------------------------------------
// Risk decisions and settlement attempts
// ---------------------------------------------------------------------------
test('risk decisions: append-only and score-checked', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  const decision = insertDecision(db, id);
  assertRejected(() => db.prepare("UPDATE risk_decision SET outcome = 'approve' WHERE decision_id = ?").run(decision), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM risk_decision').run(), 'append-only');
  assertRejected(() => db.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES ('rsk_bad', ?, 'approve', 1001, 'eyJhbGciOiJFZERTQSJ9.x.y', 'v1', ${T0}, ${T0 + 1}, ${T0})`).run(id), 'CHECK');
  assertRejected(() => db.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES ('rsk_bad2', ?, 'approve', 5, 'eyJhbGciOiJFZERTQSJ9.x.y', 'v1', ${T0}, ${T0}, ${T0})`).run(id), 'CHECK');
});

test('settlement: needs an approved decision for the same transfer and a recorded attempt', (t) => {
  const { db } = freshDb(t, 'transaction');
  const a = insertTransfer(db);
  setStatus(db, a, 'pending_settlement');
  const approvedA = insertDecision(db, a);
  // settlement_attempted_at not yet recorded
  assertRejected(() => insertAttempt(db, a, approvedA), 'settlement attempt needs');

  const b = insertTransfer(db);
  const declinedB = insertDecision(db, b, 'decline');
  const approvedB = insertDecision(db, b, 'approve');
  setStatus(db, b, 'pending_settlement', `, settlement_attempted_at = ${T0 + 10}`);
  assertRejected(() => insertAttempt(db, b, declinedB), 'settlement attempt needs');
  assertRejected(() => insertAttempt(db, b, approvedA), 'settlement attempt needs'); // other transfer's decision
  assertRejected(() => insertAttempt(db, b, approvedB, { outcome: 'settled' }), 'settlement attempt needs');
  insertAttempt(db, b, approvedB);
});

test('settlement: idempotency key is unique and attempt numbers do not repeat', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  const decision = sendToSettlement(db, id);
  insertAttempt(db, id, decision, { idempotency_key: 'cbk-key-0001' });
  assertRejected(() => insertAttempt(db, id, decision, { idempotency_key: 'cbk-key-0001', attempt_no: 2 }), 'UNIQUE');
  assertRejected(() => insertAttempt(db, id, decision, { attempt_no: 1 }), 'UNIQUE');
});

test('settlement: only a pending/unknown outcome can be resolved, then it is final', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  const decision = sendToSettlement(db, id);
  const attempt = insertAttempt(db, id, decision);

  assertRejected(() => db.prepare("UPDATE settlement_attempt SET outcome = 'settled', completed_at = ? WHERE attempt_id = ?").run(T0 + 20, attempt), 'CHECK');
  assertRejected(() => db.prepare("UPDATE settlement_attempt SET idempotency_key = 'cbk-other-1' WHERE attempt_id = ?").run(attempt), 'only a pending or unknown');
  db.prepare("UPDATE settlement_attempt SET outcome = 'unknown' WHERE attempt_id = ?").run(attempt);
  db.prepare("UPDATE settlement_attempt SET outcome = 'settled', core_banking_ref = 'cb-9', completed_at = ? WHERE attempt_id = ?").run(T0 + 20, attempt);
  assertRejected(() => db.prepare("UPDATE settlement_attempt SET outcome = 'failed' WHERE attempt_id = ?").run(attempt), 'only a pending or unknown');
  assertRejected(() => db.prepare('DELETE FROM settlement_attempt').run(), 'cannot be deleted');
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
function enqueue(db, transferId, target = 'fraud_check', id = `obx_${Math.random().toString(36).slice(2)}`) {
  db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(id, transferId, target, T0, T0, T0);
  return id;
}

test('outbox: one live message per transfer and target', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  const first = enqueue(db, id);
  assertRejected(() => enqueue(db, id), 'UNIQUE');
  enqueue(db, id, 'settlement');
  db.prepare("UPDATE outbox_message SET status = 'done', updated_at = updated_at + 1 WHERE message_id = ?").run(first);
  enqueue(db, id); // a new one is allowed once the previous is finished
});

test('outbox: leasing rules, growing attempts, final states, no deletes', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  assertRejected(() => db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, next_attempt_at, created_at, updated_at)
    VALUES ('obx_x', ?, 'fraud_check', 'leased', ${T0}, ${T0}, ${T0})`).run(id), 'must be pending');

  const msg = enqueue(db, id);
  assertRejected(() => db.prepare("UPDATE outbox_message SET status = 'leased' WHERE message_id = ?").run(msg), 'CHECK');
  db.prepare(`UPDATE outbox_message SET status = 'leased', lease_until = ${T0 + 30_000}, attempts = 1 WHERE message_id = ?`).run(msg);
  assertRejected(() => db.prepare('UPDATE outbox_message SET attempts = 0 WHERE message_id = ?').run(msg), 'attempts only grow');
  assertRejected(() => db.prepare("UPDATE outbox_message SET target = 'settlement' WHERE message_id = ?").run(msg), 'identity is fixed');
  db.prepare("UPDATE outbox_message SET status = 'dead', lease_until = NULL, last_error = 'gave up' WHERE message_id = ?").run(msg);
  assertRejected(() => db.prepare("UPDATE outbox_message SET status = 'pending' WHERE message_id = ?").run(msg), 'final');
  assertRejected(() => db.prepare('DELETE FROM outbox_message').run(), 'cannot be deleted');
});

// ---------------------------------------------------------------------------
// Audit and reconciliation
// ---------------------------------------------------------------------------
test('audit events: append-only with checked actor and event type', (t) => {
  const { db } = freshDb(t, 'transaction');
  const ins = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, NULL, ?, ?, ?, ?, ${T0})`);
  ins.run('aud_1', 'wal_alice', 'ops_user', 'ops_1', 'support.customer_view');
  assertRejected(() => ins.run('aud_2', null, 'robot', 'x', 'support.customer_view'), 'CHECK');
  assertRejected(() => ins.run('aud_3', null, 'service', 'x', 'Bad Event; DROP'), 'unknown audit event type');
  assertRejected(() => db.prepare("UPDATE audit_event SET actor_id = 'someone_else'").run(), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM audit_event').run(), 'append-only');
});

test('audit events (v2–v6): only registered event types; the type list is append-only', (t) => {
  const { db } = freshDb(t, 'transaction');
  const types = db.prepare('SELECT event_type FROM audit_event_type ORDER BY event_type').all().map((r) => r.event_type);
  assert.deepEqual(types, ['ledger.integrity_mismatch', 'outbox.requeued', 'reconciliation.mismatch', 'reconciliation.unresolved',
    'risk.decision_rejected', 'support.customer_search', 'support.customer_view', 'support.operations_view',
    'transfer.expired', 'transfer.reconciled', 'transfer.reconciled_not_posted', 'transfer.requested', 'transfer.risk_approved', 'transfer.risk_declined',
    'transfer.risk_rescreen', 'transfer.settled', 'transfer.settlement_failed', 'transfer.settlement_started', 'transfer.settlement_unknown']);
  const ins = db.prepare(`INSERT INTO audit_event (event_id, actor_type, actor_id, event_type, occurred_at) VALUES (?, 'ops_user', 'ops_1', ?, ${T0})`);
  ins.run('aud_ok', 'support.customer_search');
  assertRejected(() => ins.run('aud_new', 'ops.account_view'), 'unknown audit event type');
  assertRejected(() => db.prepare("UPDATE audit_event_type SET description = 'x'").run(), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM audit_event_type').run(), 'append-only');
});

test('reconciliation results: append-only; a match has no difference', (t) => {
  const { db } = freshDb(t, 'transaction');
  const id = insertTransfer(db);
  const ins = db.prepare(`INSERT INTO reconciliation_result (reconciliation_id, transfer_id, core_banking_ref, result, difference_cents, checked_at)
    VALUES (?, ?, 'cb-1', ?, ?, ${T0})`);
  assertRejected(() => ins.run('rec_1', id, 'matched', 5), 'CHECK');
  ins.run('rec_2', id, 'mismatched', -250);
  assertRejected(() => db.prepare("UPDATE reconciliation_result SET result = 'matched', difference_cents = NULL").run(), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM reconciliation_result').run(), 'append-only');
});

test('foreign keys are enforced on the opened connection', (t) => {
  const { db } = freshDb(t, 'transaction');
  assertRejected(() => insertDecision(db, 'trf_does_not_exist'), 'FOREIGN KEY');
});
