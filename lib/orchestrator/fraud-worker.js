// Fraud outbox worker – the Orchestrator's consumer of `fraud_check` outbox messages (Step 6).
//
// For each due message:
//   1. CLAIM (one BEGIN IMMEDIATE transaction): status pending → leased, lease_until set,
//      attempts + 1. The new attempts value is this worker's fencing token: every later
//      write requires the message to be still leased with exactly that attempts value, so
//      a worker whose lease ran out (and was taken over) can no longer change anything.
//      An expired lease (crashed worker) is claimable again.
//   2. Read the transfer from the database. Not pending_risk any more → the message is
//      done (duplicate delivery); nothing is screened or applied.
//   3. Send the exact recorded transfer fields to Fraud & Risk Check over mTLS, with a
//      request id unique to this attempt.
//   4. Verify the signed decision: signature, key id, type, issuer, audience, lifetime,
//      expiry, request id and the full transfer binding (lib/fraud/risk-decision.js).
//      A network answer that does not verify is never applied (fail closed).
//   5. APPLY (one BEGIN IMMEDIATE transaction, fenced): store the decision (its id is a
//      primary key – a replayed decision cannot apply twice), pending_risk →
//      pending_settlement | declined, audit event, a `settlement` outbox message for an
//      approval, and only then fraud_check → done.
// Any failure before APPLY commits leaves the transfer pending_risk and the message
// pending again with a backoff (or `dead` after MAX_ATTEMPTS, still pending_risk).

import crypto from 'node:crypto';

import { bindingOf, RiskDecisionError, verifyRiskDecision } from '../fraud/risk-decision.js';

export const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60_000;
export const backoffMs = (attempt) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));

export const RISK_EVENTS = Object.freeze({
  approved: 'transfer.risk_approved',
  declined: 'transfer.risk_declined',
  rejected: 'risk.decision_rejected',
});
const WORKER_ID = 'vaultpay-orchestrator';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const short = (text) => String(text).slice(0, 200);

/**
 * deps: { db (writable transaction DB), requestDecision(body) → { status, json },
 *         publicKey, keyId (risk-decision verification key), now, leaseMs, maxAttempts, log }
 */
export function createFraudWorker({ db, requestDecision, publicKey, keyId, now = () => Date.now(), leaseMs = LEASE_MS, maxAttempts = MAX_ATTEMPTS, log = () => {} }) {
  const due = db.prepare(`SELECT message_id, transfer_id, attempts FROM outbox_message
    WHERE target = 'fraud_check'
      AND ((status = 'pending' AND next_attempt_at <= @t) OR (status = 'leased' AND lease_until <= @t))
    ORDER BY next_attempt_at, created_at, rowid LIMIT 1`);
  const lease = db.prepare(`UPDATE outbox_message SET status = 'leased', lease_until = @until, attempts = attempts + 1, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND attempts = @attempts AND status IN ('pending', 'leased')`);
  const fence = db.prepare(`SELECT 1 FROM outbox_message WHERE message_id = ? AND status = 'leased' AND attempts = ?`);
  const finish = db.prepare(`UPDATE outbox_message SET status = 'done', lease_until = NULL, last_error = NULL, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND status = 'leased' AND attempts = @attempts`);
  const release = db.prepare(`UPDATE outbox_message SET status = @status, lease_until = NULL, next_attempt_at = @next, last_error = @error, updated_at = max(updated_at, @t)
    WHERE message_id = @id AND status = 'leased' AND attempts = @attempts`);
  const transferById = db.prepare(`SELECT transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, currency, status, created_at
    FROM transfer WHERE transfer_id = ?`);
  const insertDecision = db.prepare(`INSERT INTO risk_decision (decision_id, transfer_id, outcome, risk_score, signature, key_version, issued_at, expires_at, created_at)
    VALUES (@decisionId, @transferId, @outcome, @riskScore, @signature, @keyId, @issuedAt, @expiresAt, @t)`);
  const moveTransfer = db.prepare(`UPDATE transfer SET status = @status, updated_at = max(updated_at, @t)
    WHERE transfer_id = @transferId AND status = 'pending_risk'`);
  const insertAudit = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, ?, ?, 'service', ?, ?, ?)`);
  const enqueueSettlement = db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at)
    VALUES (?, ?, 'settlement', 'pending', 0, ?, NULL, NULL, ?, ?)`);

  /** Claims the next due message, or returns null. */
  const claimNext = db.transaction(() => {
    const t = now();
    const row = due.get({ t });
    if (!row) return null;
    const changed = lease.run({ id: row.message_id, attempts: row.attempts, until: t + leaseMs, t }).changes;
    if (changed !== 1) return null;
    return Object.freeze({ messageId: row.message_id, transferId: row.transfer_id, attempt: row.attempts + 1 });
  });

  const retry = db.transaction((claim, error, rejected) => {
    const t = now();
    if (rejected) {
      const trf = transferById.get(claim.transferId);
      insertAudit.run(newId('aud'), claim.transferId, trf?.sender_wallet_id ?? null, WORKER_ID, RISK_EVENTS.rejected, t);
    }
    const dead = claim.attempt >= maxAttempts;
    const changed = release.run({ id: claim.messageId, attempts: claim.attempt, status: dead ? 'dead' : 'pending', next: t + backoffMs(claim.attempt), error: short(error), t }).changes;
    if (changed !== 1) throw new LeaseLost();
    return dead ? 'dead' : 'retry';
  });

  const skip = db.transaction((claim) => {
    if (finish.run({ id: claim.messageId, attempts: claim.attempt, t: now() }).changes !== 1) throw new LeaseLost();
  });

  const apply = db.transaction((claim, decision, signature) => {
    const t = now();
    if (!fence.get(claim.messageId, claim.attempt)) throw new LeaseLost();
    if (decision.expiresAt <= t) throw new RiskDecisionError('expired');
    const trf = transferById.get(claim.transferId);
    if (trf?.status !== 'pending_risk') {
      finish.run({ id: claim.messageId, attempts: claim.attempt, t });
      return 'skipped';
    }
    insertDecision.run({
      decisionId: decision.decisionId, transferId: claim.transferId, outcome: decision.outcome, riskScore: decision.riskScore,
      signature, keyId: decision.keyId, issuedAt: decision.issuedAt, expiresAt: decision.expiresAt, t,
    });
    const status = decision.outcome === 'approve' ? 'pending_settlement' : 'declined';
    if (moveTransfer.run({ status, transferId: claim.transferId, t }).changes !== 1) throw new Error('transfer changed during apply');
    insertAudit.run(newId('aud'), claim.transferId, trf.sender_wallet_id, 'vaultpay-fraud', decision.outcome === 'approve' ? RISK_EVENTS.approved : RISK_EVENTS.declined, t);
    if (decision.outcome === 'approve') enqueueSettlement.run(newId('obx'), claim.transferId, t, t, t);
    if (finish.run({ id: claim.messageId, attempts: claim.attempt, t }).changes !== 1) throw new LeaseLost();
    return status;
  });

  /** Processes one claimed message. Returns 'pending_settlement' | 'declined' | 'skipped' | 'retry' | 'dead' | 'lease_lost'. */
  async function process(claim) {
    const fail = (error, rejected = false) => {
      log(`${claim.transferId}: not applied (${error}), attempt ${claim.attempt}`);
      try {
        return retry.immediate(claim, error, rejected);
      } catch (err) {
        if (err instanceof LeaseLost) return 'lease_lost';
        throw err; // database unusable: the lease expires and another run picks it up
      }
    };
    try {
      const trf = transferById.get(claim.transferId);
      if (trf?.status !== 'pending_risk') {
        skip.immediate(claim);
        return 'skipped';
      }
      const expected = bindingOf(trf);
      const requestId = `${claim.messageId}:${claim.attempt}`;

      let response;
      try {
        response = await requestDecision({ requestId, transfer: expected, createdAt: trf.created_at });
      } catch (err) {
        return fail(`fraud_${err.code ?? 'error'}`);
      }
      if (response?.status !== 200 || typeof response.json?.decision !== 'string') return fail(`fraud_status_${response?.status ?? 'none'}`);

      let decision;
      try {
        decision = await verifyRiskDecision(response.json.decision, { publicKey, keyId, expected, requestId, now: now() });
      } catch (err) {
        if (err instanceof RiskDecisionError) return fail(`invalid_decision:${err.reason}`, true);
        throw err;
      }

      try {
        const result = apply.immediate(claim, decision, response.json.decision);
        log(`${claim.transferId}: ${result} (risk score ${decision.riskScore}${decision.reasons.length ? `, ${decision.reasons.join(', ')}` : ''})`);
        return result;
      } catch (err) {
        if (err instanceof LeaseLost) return 'lease_lost';
        if (err instanceof RiskDecisionError) return fail(`invalid_decision:${err.reason}`, true);
        // A decision id that already exists is a replay: refused by the primary key.
        if (err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return fail('invalid_decision:replayed', true);
        return fail(`apply_failed:${err.code ?? err.name}`);
      }
    } catch (err) {
      if (err instanceof LeaseLost) return 'lease_lost';
      throw err;
    }
  }

  return Object.freeze({
    claimNext: () => claimNext.immediate(),
    process,
    /** Processes due messages until none is left (or `max`). Returns counts per result. */
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

class LeaseLost extends Error {
  constructor() {
    super('outbox lease lost to another worker');
    this.name = 'LeaseLost';
  }
}
