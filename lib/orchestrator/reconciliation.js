// Reconciliation and recovery (Step 8) – Reconciliation & Audit, run by `npm run reconcile`.
//
// reconcile: transfers in settlement_in_flight whose open attempt (outcome pending/unknown)
//   is older than minAgeMs and that no worker is actively processing (no unexpired lease).
//   The bank is asked – read-only, through Identity + CBI, by the attempt's OWN idempotency
//   key – whether it holds that posting, and CBI compares transfer id, accounts, amount and
//   currency:
//     posted    → one transaction: attempt settled + posting ref, transfer completed, one
//                 ledger debit + credit, reconciliation_result "matched", audit
//                 transfer.reconciled, any live settlement message closed
//     not_found → left UNRESOLVED (audit reconciliation.unresolved), funds stay reserved.
//                 "No posting yet" is not proof that none will appear: a request with this
//                 key may already be inside the bank (CBI gave up after 3 s, the bank commits
//                 when it gets its database lock, or after a pause). Failing the transfer
//                 could leave a later bank debit without a ledger entry (Step 9 review), so
//                 a missing posting is never turned into "failed" here. If the posting
//                 appears later, the next pass completes the transfer; otherwise an
//                 operator resolves it with the bank (docs/SETUP.md).
//     mismatch  → result "mismatched" + audit reconciliation.mismatch, left in flight (funds
//                 stay reserved) for investigation – never corrected automatically
//     unknown / outage / invalid answer → audit reconciliation.unresolved, nothing changes
//   Reconciliation never posts: it cannot start a payment, with this key or any other.
// expire: pending_risk / pending_settlement transfers past pending_expires_at that never had
//   a settlement attempt (the schema forbids expiring any other) and are not leased right
//   now → expired; their live outbox messages closed; audit transfer.expired.
// requeue (operator flag only): a parked (dead) fraud_check of a transfer still in
//   pending_risk, or a parked settlement message of a transfer still in pending_settlement,
//   gets a NEW pending message (attempts 0); the parked one stays as it was. In-flight
//   transfers are never requeued – reconciliation resolves them with their existing key.
// ledger: integrity issues are recorded (audit ledger.integrity_mismatch), never corrected.

import crypto from 'node:crypto';

import { ledgerIntegrityIssues } from '../server/operations.js';
import { mtlsRequest } from '../services/mtls-request.js';

export const RECONCILE_MIN_AGE_MS = 120_000;
export const RECON_EVENTS = Object.freeze({
  reconciled: 'transfer.reconciled',
  // transfer.reconciled_not_posted (migration 0006) is no longer written: see not_found above.
  mismatch: 'reconciliation.mismatch',
  unresolved: 'reconciliation.unresolved',
  expired: 'transfer.expired',
  requeued: 'outbox.requeued',
  integrity: 'ledger.integrity_mismatch',
});
const ACTOR = 'vaultpay-recon';
const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

/**
 * The read-only bank lookup over Reconciliation's own certificate (CN=vaultpay-recon):
 * Identity issues a single-use records:read token naming the accounts; CBI compares the
 * bank's record with it. Any failure throws, which the reconciler treats as "unknown".
 */
export function createPostingLookup({ credentials, identityPort, cbiPort, timeoutMs = 6000 }) {
  return async function lookupPosting({ transfer, idempotencyKey }) {
    const issued = await mtlsRequest({
      port: identityPort, method: 'POST', path: '/v1/service-tokens/reconciliation', credentials, expectedServer: 'vaultpay-identity',
      body: {
        transferId: transfer.id, idempotencyKey, senderWalletId: transfer.sender_wallet_id, payeeType: transfer.payee_type,
        payeeId: transfer.payee_id, amountCents: transfer.amount_cents, currency: transfer.currency,
      },
    });
    if (issued.status !== 200 || typeof issued.json?.token !== 'string') throw Object.assign(new Error('no lookup token'), { code: `identity_${issued.status}` });
    const res = await mtlsRequest({
      port: cbiPort, method: 'POST', path: '/v1/postings/lookup', credentials, expectedServer: 'vaultpay-cbi',
      headers: { authorization: `Bearer ${issued.json.token}` }, timeoutMs,
    });
    if (res.status !== 200) throw Object.assign(new Error('lookup failed'), { code: `cbi_${res.status}` });
    return res.json;
  };
}

/**
 * deps: { db (writable transaction DB), lookupPosting({ transfer, idempotencyKey }) →
 *         { status: 'posted', postingRef } | { status: 'not_found' } | { status: 'mismatch' }
 *         (throws or returns anything else when the outcome cannot be determined),
 *         now, minAgeMs, log }
 */
export function createReconciler({ db, lookupPosting, now = () => Date.now(), minAgeMs = RECONCILE_MIN_AGE_MS, log = () => {} }) {
  const candidates = db.prepare(`SELECT t.transfer_id, t.sender_wallet_id, t.payee_type, t.payee_id, t.amount_cents, t.currency,
      a.attempt_id, a.idempotency_key
    FROM transfer t JOIN settlement_attempt a ON a.transfer_id = t.transfer_id AND a.outcome IN ('pending', 'unknown')
    WHERE t.status = 'settlement_in_flight' AND a.requested_at <= ? ORDER BY a.requested_at`);
  const liveLease = db.prepare("SELECT 1 FROM outbox_message WHERE transfer_id = ? AND status = 'leased' AND lease_until > ?");
  const stillOpen = db.prepare(`SELECT 1 FROM transfer t JOIN settlement_attempt a ON a.transfer_id = t.transfer_id
    WHERE t.transfer_id = ? AND t.status = 'settlement_in_flight' AND a.attempt_id = ? AND a.outcome IN ('pending', 'unknown')`);
  const attemptOutcome = db.prepare(`UPDATE settlement_attempt SET outcome = @outcome, core_banking_ref = @ref, completed_at = @t
    WHERE attempt_id = @id AND outcome IN ('pending', 'unknown')`);
  const setStatus = db.prepare(`UPDATE transfer SET status = @to, updated_at = max(updated_at, @t)
    WHERE transfer_id = @id AND status = @from`);
  const insertLedger = db.prepare(`INSERT INTO ledger_entry (entry_id, transfer_id, account_type, account_id, direction, amount_cents, currency, core_banking_ref, created_at)
    VALUES (@entryId, @transferId, @accountType, @accountId, @direction, @amount, @currency, @ref, @t)`);
  const insertResult = db.prepare(`INSERT INTO reconciliation_result (reconciliation_id, transfer_id, core_banking_ref, result, difference_cents, checked_at)
    VALUES (?, ?, ?, ?, NULL, ?)`);
  const hasMismatch = db.prepare("SELECT 1 FROM reconciliation_result WHERE transfer_id = ? AND result = 'mismatched'");
  const closeMessages = db.prepare(`UPDATE outbox_message SET status = 'done', lease_until = NULL, last_error = @why, updated_at = max(updated_at, @t)
    WHERE transfer_id = @id AND status IN ('pending', 'leased') AND (@target IS NULL OR target = @target)`);
  const insertAudit = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, ?, ?, 'service', ?, ?, ?)`);
  const audit = (transferId, walletId, type, t) => insertAudit.run(newId('aud'), transferId, walletId, ACTOR, type, t);

  const complete = db.transaction((c, postingRef) => {
    const t = now();
    if (!stillOpen.get(c.transfer_id, c.attempt_id)) return 'already_resolved';
    if (liveLease.get(c.transfer_id, t)) return 'busy';
    if (attemptOutcome.run({ id: c.attempt_id, outcome: 'settled', ref: postingRef, t }).changes !== 1) return 'already_resolved';
    if (setStatus.run({ id: c.transfer_id, from: 'settlement_in_flight', to: 'completed', t }).changes !== 1) throw new Error('transfer changed concurrently');
    const entry = { transferId: c.transfer_id, amount: c.amount_cents, currency: c.currency, ref: postingRef, t };
    insertLedger.run({ ...entry, entryId: newId('led'), accountType: 'wallet', accountId: c.sender_wallet_id, direction: 'debit' });
    insertLedger.run({ ...entry, entryId: newId('led'), accountType: c.payee_type, accountId: c.payee_id, direction: 'credit' });
    insertResult.run(newId('rec'), c.transfer_id, postingRef, 'matched', t);
    audit(c.transfer_id, c.sender_wallet_id, RECON_EVENTS.reconciled, t);
    closeMessages.run({ id: c.transfer_id, target: 'settlement', why: 'reconciled', t });
    return 'completed';
  });

  // Recorded, never acted on (see the header): the transfer stays in flight and reserved.
  const notFound = db.transaction((c) => {
    if (!stillOpen.get(c.transfer_id, c.attempt_id)) return 'already_resolved';
    audit(c.transfer_id, c.sender_wallet_id, RECON_EVENTS.unresolved, now());
    return 'not_found';
  });

  const mismatch = db.transaction((c) => {
    const t = now();
    if (!stillOpen.get(c.transfer_id, c.attempt_id)) return 'already_resolved';
    if (!hasMismatch.get(c.transfer_id)) {
      insertResult.run(newId('rec'), c.transfer_id, null, 'mismatched', t);
      audit(c.transfer_id, c.sender_wallet_id, RECON_EVENTS.mismatch, t);
    }
    return 'mismatch';
  });

  const unresolved = db.transaction((c) => {
    audit(c.transfer_id, c.sender_wallet_id, RECON_EVENTS.unresolved, now());
    return 'unresolved';
  });

  async function reconcileOne(c) {
    if (liveLease.get(c.transfer_id, now())) return 'busy'; // a worker is on it right now
    let answer;
    try {
      answer = await lookupPosting({
        transfer: { id: c.transfer_id, sender_wallet_id: c.sender_wallet_id, payee_type: c.payee_type, payee_id: c.payee_id, amount_cents: c.amount_cents, currency: c.currency },
        idempotencyKey: c.idempotency_key,
      });
    } catch (err) {
      log(`${c.transfer_id}: outcome still unknown (${err.code ?? 'error'})`);
      return unresolved.immediate(c);
    }
    let result;
    if (answer?.status === 'posted' && /^MCBP-[0-9a-f]{20}$/.test(answer.postingRef ?? '')) result = complete.immediate(c, answer.postingRef);
    else if (answer?.status === 'not_found') result = notFound.immediate(c);
    else if (answer?.status === 'mismatch') result = mismatch.immediate(c);
    else result = unresolved.immediate(c);
    log(`${c.transfer_id}: ${result}`);
    return result;
  }

  const expireOverdue = db.transaction(() => {
    const t = now();
    const rows = db.prepare(`SELECT transfer_id, sender_wallet_id, status FROM transfer
      WHERE status IN ('pending_risk', 'pending_settlement') AND pending_expires_at <= ? AND settlement_attempted_at IS NULL`).all(t);
    let n = 0;
    for (const r of rows) {
      if (liveLease.get(r.transfer_id, t)) continue; // being screened or started right now – next run
      if (setStatus.run({ id: r.transfer_id, from: r.status, to: 'expired', t }).changes !== 1) continue;
      closeMessages.run({ id: r.transfer_id, target: null, why: 'transfer_expired', t });
      audit(r.transfer_id, r.sender_wallet_id, RECON_EVENTS.expired, t);
      n += 1;
    }
    return n;
  });

  const requeueParked = db.transaction(() => {
    const t = now();
    const rows = db.prepare(`SELECT m.transfer_id, m.target, t.sender_wallet_id FROM outbox_message m JOIN transfer t ON t.transfer_id = m.transfer_id
      WHERE m.status = 'dead'
        AND ((m.target = 'fraud_check' AND t.status = 'pending_risk') OR (m.target = 'settlement' AND t.status = 'pending_settlement'))
        AND m.rowid = (SELECT max(rowid) FROM outbox_message x WHERE x.transfer_id = m.transfer_id AND x.target = m.target)`).all();
    const insert = db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`);
    for (const r of rows) {
      insert.run(newId('obx'), r.transfer_id, r.target, t, t, t);
      audit(r.transfer_id, r.sender_wallet_id, RECON_EVENTS.requeued, t);
    }
    return rows.length;
  });

  const recordIntegrity = db.transaction(() => {
    const issues = ledgerIntegrityIssues(db);
    for (const i of issues) audit(i.transferId, null, RECON_EVENTS.integrity, now());
    return issues;
  });

  return Object.freeze({
    expireOverdue: () => expireOverdue.immediate(),
    requeueParked: () => requeueParked.immediate(),
    checkLedger: () => recordIntegrity.immediate(),
    async reconcile() {
      const counts = {};
      for (const c of candidates.all(now() - minAgeMs)) {
        const r = await reconcileOne(c);
        counts[r] = (counts[r] ?? 0) + 1;
      }
      return counts;
    },
    /** One full pass. `requeue` only when an operator asks for it. */
    async runOnce({ requeue = false } = {}) {
      const expired = this.expireOverdue();
      const requeued = requeue ? this.requeueParked() : 0;
      const reconciled = await this.reconcile();
      const integrity = this.checkLedger();
      return { expired, requeued, reconciled, integrityIssues: integrity.length };
    },
  });
}
