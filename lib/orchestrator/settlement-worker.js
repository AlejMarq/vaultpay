// Settlement outbox worker – the Orchestrator's consumer of `settlement` outbox messages (Step 7).
//
// Leases and fencing work exactly like the fraud worker (lib/orchestrator/fraud-worker.js):
// a claim is a database lease and its `attempts` value is the fencing token for every write.
//
// For a transfer in pending_settlement:
//   - the stored fraud approval is verified again (signature, binding to this transfer's
//     row, unexpired with at least MIN_APPROVAL_REMAINING_MS left). If it is expired or no
//     longer verifies, the transfer goes BACK to pending_risk with a new fraud_check message
//     (re-screening) – nothing is sent to the bank.
//   - otherwise, in one transaction and BEFORE anything leaves (D5): transfer →
//     settlement_in_flight with settlement_attempted_at, a settlement_attempt with a fresh
//     bank idempotency key (outcome pending), audit transfer.settlement_started.
// For a transfer already settlement_in_flight (a retry, a crash, a timeout): the open
// attempt is sent again with the SAME idempotency key – the bank returns the original
// posting instead of moving money twice.
//
// Outcomes (from the Settlement service):
//   settled  → one transaction: attempt settled + bank posting ref, transfer completed,
//              ledger debit + credit (with the posting ref), audit, message done
//   rejected → the bank evaluated this key and refused. Definitive (attempt failed, transfer
//              failed, audit, message done – no money moved) only for an attempt created in
//              THIS claim: its key was sent exactly once. After an earlier unanswered send,
//              that earlier request may still be queued inside the bank and post after this
//              refusal, so the refusal is treated as unknown (Step 9 review).
//   refused  → before the bank. Definitive only for an attempt created in THIS claim (its key
//              was never sent before); otherwise treated as unknown.
//   unknown / not_sent / no answer → attempt outcome unknown (if it was ever sent), transfer
//              stays settlement_in_flight, message retried with backoff using the same key.
// When an in-flight transfer's approval has expired, the same key can no longer be
// resubmitted: the message is parked as dead with "needs_reconciliation" and the transfer
// stays settlement_in_flight (never completed or failed by guesswork).

import crypto from 'node:crypto';

import { ANY_REQUEST, bindingOf, RiskDecisionError, verifyRiskDecision } from '../fraud/risk-decision.js';
import { backoffMs } from './fraud-worker.js';

export const SETTLEMENT_LEASE_MS = 60_000;
export const SETTLEMENT_MAX_ATTEMPTS = 10;
export const MIN_APPROVAL_REMAINING_MS = 60_000;

export const SETTLEMENT_EVENTS = Object.freeze({
  started: 'transfer.settlement_started',
  settled: 'transfer.settled',
  failed: 'transfer.settlement_failed',
  unknown: 'transfer.settlement_unknown',
  rescreen: 'transfer.risk_rescreen',
});
const ACTOR = 'vaultpay-orchestrator';
const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

class LeaseLost extends Error {
  constructor() {
    super('outbox lease lost to another worker');
    this.name = 'LeaseLost';
  }
}

/**
 * deps: { db (writable transaction DB), requestSettlement(body) → { status, json },
 *         publicKey, keyId (risk-decision verification key), now, leaseMs, maxAttempts, log }
 */
export function createSettlementWorker({
  db, requestSettlement, publicKey, keyId, now = () => Date.now(),
  leaseMs = SETTLEMENT_LEASE_MS, maxAttempts = SETTLEMENT_MAX_ATTEMPTS, minApprovalRemainingMs = MIN_APPROVAL_REMAINING_MS, log = () => {},
}) {
  const due = db.prepare(`SELECT message_id, transfer_id, attempts FROM outbox_message
    WHERE target = 'settlement'
      AND ((status = 'pending' AND next_attempt_at <= @t) OR (status = 'leased' AND lease_until <= @t))
    ORDER BY next_attempt_at, created_at, rowid LIMIT 1`);
  const lease = db.prepare(`UPDATE outbox_message SET status = 'leased', lease_until = @until, attempts = attempts + 1, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND attempts = @attempts AND status IN ('pending', 'leased')`);
  const fence = db.prepare("SELECT 1 FROM outbox_message WHERE message_id = ? AND status = 'leased' AND attempts = ?");
  const finish = db.prepare(`UPDATE outbox_message SET status = 'done', lease_until = NULL, last_error = NULL, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND status = 'leased' AND attempts = @attempts`);
  const release = db.prepare(`UPDATE outbox_message SET status = @status, lease_until = NULL, next_attempt_at = @next, last_error = @error, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND status = 'leased' AND attempts = @attempts`);
  const transferById = db.prepare(`SELECT transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, currency, status, created_at
    FROM transfer WHERE transfer_id = ?`);
  const latestApproval = db.prepare(`SELECT decision_id, signature FROM risk_decision WHERE transfer_id = ? AND outcome = 'approve'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const decisionById = db.prepare("SELECT decision_id, signature FROM risk_decision WHERE decision_id = ? AND transfer_id = ? AND outcome = 'approve'");
  const openAttempt = db.prepare(`SELECT attempt_id, decision_id, idempotency_key, outcome FROM settlement_attempt
    WHERE transfer_id = ? AND outcome IN ('pending', 'unknown') ORDER BY attempt_no DESC LIMIT 1`);
  const attemptCount = db.prepare('SELECT count(*) AS n FROM settlement_attempt WHERE transfer_id = ?');
  const setStatus = db.prepare(`UPDATE transfer SET status = @to, updated_at = max(updated_at, @t),
      settlement_attempted_at = CASE WHEN @to = 'settlement_in_flight' THEN @t ELSE settlement_attempted_at END
    WHERE transfer_id = @id AND status = @from`);
  const insertAttempt = db.prepare(`INSERT INTO settlement_attempt (attempt_id, transfer_id, decision_id, attempt_no, idempotency_key, requested_at, outcome)
    VALUES (@attemptId, @transferId, @decisionId, @attemptNo, @key, @t, 'pending')`);
  const attemptOutcome = db.prepare(`UPDATE settlement_attempt SET outcome = @outcome, core_banking_ref = @ref, completed_at = @completedAt
    WHERE attempt_id = @id AND outcome IN ('pending', 'unknown')`);
  const insertLedger = db.prepare(`INSERT INTO ledger_entry (entry_id, transfer_id, account_type, account_id, direction, amount_cents, currency, core_banking_ref, created_at)
    VALUES (@entryId, @transferId, @accountType, @accountId, @direction, @amount, @currency, @ref, @t)`);
  const enqueueFraud = db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at)
    VALUES (?, ?, 'fraud_check', 'pending', 0, ?, NULL, NULL, ?, ?)`);
  const insertAudit = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, ?, ?, 'service', ?, ?, ?)`);
  const audit = (trf, type, t, actor = ACTOR) => insertAudit.run(newId('aud'), trf.transfer_id, trf.sender_wallet_id, actor, type, t);

  const checkFence = (claim) => {
    if (!fence.get(claim.messageId, claim.attempt)) throw new LeaseLost();
  };
  const done = (claim, t) => {
    if (finish.run({ id: claim.messageId, attempts: claim.attempt, t }).changes !== 1) throw new LeaseLost();
  };
  const moved = (r) => {
    if (r.changes !== 1) throw new Error('transfer changed concurrently');
  };

  const claimNext = db.transaction(() => {
    const t = now();
    const row = due.get({ t });
    if (!row) return null;
    if (lease.run({ id: row.message_id, attempts: row.attempts, until: t + leaseMs, t }).changes !== 1) return null;
    return Object.freeze({ messageId: row.message_id, transferId: row.transfer_id, attempt: row.attempts + 1 });
  });

  const skip = db.transaction((claim) => done(claim, now()));

  const retry = db.transaction((claim, error, { markUnknown = null, dead = false } = {}) => {
    const t = now();
    checkFence(claim);
    if (markUnknown) {
      const changed = attemptOutcome.run({ id: markUnknown.attemptId, outcome: 'unknown', ref: null, completedAt: null }).changes;
      if (changed && markUnknown.wasPending) audit(markUnknown.trf, SETTLEMENT_EVENTS.unknown, t);
    }
    const park = dead || claim.attempt >= maxAttempts;
    release.run({ id: claim.messageId, attempts: claim.attempt, status: park ? 'dead' : 'pending', next: t + backoffMs(claim.attempt), error: String(error).slice(0, 200), t });
    return park ? 'dead' : 'retry';
  });

  const rescreen = db.transaction((claim, trf, why) => {
    const t = now();
    checkFence(claim);
    moved(setStatus.run({ id: trf.transfer_id, from: 'pending_settlement', to: 'pending_risk', t }));
    enqueueFraud.run(newId('obx'), trf.transfer_id, t, t, t);
    audit(trf, SETTLEMENT_EVENTS.rescreen, t);
    done(claim, t);
    log(`${trf.transfer_id}: approval ${why} – back to fraud screening`);
    return 'rescreened';
  });

  const start = db.transaction((claim, trf, decisionId) => {
    const t = now();
    checkFence(claim);
    moved(setStatus.run({ id: trf.transfer_id, from: 'pending_settlement', to: 'settlement_in_flight', t }));
    const attempt = {
      attemptId: newId('stl'), transferId: trf.transfer_id, decisionId,
      attemptNo: attemptCount.get(trf.transfer_id).n + 1, key: `stlk_${crypto.randomBytes(12).toString('hex')}`, t,
    };
    insertAttempt.run(attempt);
    audit(trf, SETTLEMENT_EVENTS.started, t);
    return { attemptId: attempt.attemptId, decisionId, idempotencyKey: attempt.key, outcome: 'pending' };
  });

  const complete = db.transaction((claim, trf, attempt, postingRef) => {
    const t = now();
    checkFence(claim);
    if (attemptOutcome.run({ id: attempt.attemptId, outcome: 'settled', ref: postingRef, completedAt: t }).changes !== 1) throw new LeaseLost();
    moved(setStatus.run({ id: trf.transfer_id, from: 'settlement_in_flight', to: 'completed', t }));
    const entry = { transferId: trf.transfer_id, amount: trf.amount_cents, currency: trf.currency, ref: postingRef, t };
    insertLedger.run({ ...entry, entryId: newId('led'), accountType: 'wallet', accountId: trf.sender_wallet_id, direction: 'debit' });
    insertLedger.run({ ...entry, entryId: newId('led'), accountType: trf.payee_type, accountId: trf.payee_id, direction: 'credit' });
    audit(trf, SETTLEMENT_EVENTS.settled, t);
    done(claim, t);
    return 'completed';
  });

  const fail = db.transaction((claim, trf, attempt) => {
    const t = now();
    checkFence(claim);
    if (attemptOutcome.run({ id: attempt.attemptId, outcome: 'failed', ref: null, completedAt: t }).changes !== 1) throw new LeaseLost();
    moved(setStatus.run({ id: trf.transfer_id, from: 'settlement_in_flight', to: 'failed', t }));
    audit(trf, SETTLEMENT_EVENTS.failed, t);
    done(claim, t);
    return 'failed';
  });

  const verifyApproval = (row, trf) => verifyRiskDecision(row.signature, { publicKey, keyId, expected: bindingOf(trf), requestId: ANY_REQUEST, now: now() });

  async function process(claim) {
    try {
      const trf = transferById.get(claim.transferId);
      let attempt;
      let approval;
      let fresh = false;

      if (trf?.status === 'pending_settlement') {
        approval = latestApproval.get(trf.transfer_id);
        if (!approval) return rescreen.immediate(claim, trf, 'missing');
        try {
          const d = await verifyApproval(approval, trf);
          if (d.outcome !== 'approve') return rescreen.immediate(claim, trf, 'not an approval');
          if (d.expiresAt - now() < minApprovalRemainingMs) return rescreen.immediate(claim, trf, 'expired');
        } catch (err) {
          if (err instanceof RiskDecisionError) return rescreen.immediate(claim, trf, err.reason === 'expired' ? 'expired' : `invalid (${err.reason})`);
          throw err;
        }
        attempt = start.immediate(claim, trf, approval.decision_id);
        fresh = true;
      } else if (trf?.status === 'settlement_in_flight') {
        attempt = openAttempt.get(trf.transfer_id);
        if (!attempt) return retry.immediate(claim, 'no_open_attempt', { dead: true });
        attempt = { attemptId: attempt.attempt_id, decisionId: attempt.decision_id, idempotencyKey: attempt.idempotency_key, outcome: attempt.outcome };
        approval = decisionById.get(attempt.decisionId, trf.transfer_id);
        try {
          if (!approval) throw new RiskDecisionError('missing');
          await verifyApproval(approval, trf);
        } catch (err) {
          if (!(err instanceof RiskDecisionError)) throw err;
          // The same key cannot be resubmitted without a valid approval: hand over to reconciliation.
          log(`${trf.transfer_id}: approval ${err.reason}, outcome unknown – needs reconciliation`);
          return retry.immediate(claim, 'needs_reconciliation', { dead: true });
        }
      } else {
        skip.immediate(claim); // duplicate delivery, or already finished
        return 'skipped';
      }

      let response;
      try {
        response = await requestSettlement({ transfer: bindingOf(trf), idempotencyKey: attempt.idempotencyKey, riskDecision: approval.signature });
      } catch (err) {
        return retry.immediate(claim, `settlement_${err.code ?? 'error'}`, { markUnknown: { attemptId: attempt.attemptId, trf, wasPending: attempt.outcome === 'pending' } });
      }
      const outcome = response?.status === 200 ? response.json?.outcome : undefined;
      if (outcome === 'settled' && /^MCBP-[0-9a-f]{20}$/.test(response.json.postingRef ?? '')) {
        const r = complete.immediate(claim, trf, attempt, response.json.postingRef);
        log(`${trf.transfer_id}: completed (posting confirmed)`);
        return r;
      }
      if ((outcome === 'rejected' || outcome === 'refused') && fresh) {
        const r = fail.immediate(claim, trf, attempt);
        log(`${trf.transfer_id}: failed (${outcome}: ${String(response.json.reason ?? '').slice(0, 40)})`);
        return r;
      }
      if (outcome === 'not_sent' && fresh) return retry.immediate(claim, 'settlement_not_sent');
      return retry.immediate(claim, `settlement_${outcome ?? `status_${response?.status ?? 'none'}`}`, {
        markUnknown: { attemptId: attempt.attemptId, trf, wasPending: attempt.outcome === 'pending' },
      });
    } catch (err) {
      if (err instanceof LeaseLost) return 'lease_lost';
      throw err;
    }
  }

  return Object.freeze({
    claimNext: () => claimNext.immediate(),
    process,
    async runOnce({ max = 100 } = {}) {
      const counts = {};
      for (let i = 0; i < max; i += 1) {
        const claim = claimNext.immediate();
        if (!claim) break;
        const result = await process(claim);
        counts[result] = (counts[result] ?? 0) + 1;
      }
      return counts;
    },
  });
}
