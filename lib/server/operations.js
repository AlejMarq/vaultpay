// Read-only operations overview for support_readonly users (Step 8) and the ledger
// integrity check shared with the reconciliation process.
//
// Shows only operational facts: transfer and outbox counts, parked messages, transfers
// awaiting reconciliation, reconciliation results, ledger totals and integrity issues,
// recent operational audit events. It never returns customer names, emails, wallet ids,
// bank account references, posting references, idempotency keys or decision tokens – the
// identifiers shown are VaultPay transfer ids. Viewing is recorded by the append-only audit
// writer BEFORE anything is returned (fail closed). There is no write path here.

import { assertSupport } from './dal.js';
import { SUPPORT_EVENTS } from './audit.js';

const LIST_LIMIT = 50;
const OPERATIONAL_EVENTS = [
  'transfer.reconciled', 'reconciliation.mismatch', 'reconciliation.unresolved',
  'transfer.expired', 'outbox.requeued', 'ledger.integrity_mismatch', 'transfer.settlement_unknown', 'transfer.risk_rescreen',
];

/**
 * Ledger integrity, without correcting anything: total debits = credits; every completed
 * transfer has exactly one debit and one credit of its amount; no other transfer has
 * postings. Returns [{ transferId | null, issue }].
 */
export function ledgerIntegrityIssues(transactionDb) {
  const issues = [];
  const totals = transactionDb.prepare('SELECT debit_cents, credit_cents FROM ledger_totals').get();
  if (totals.debit_cents !== totals.credit_cents) issues.push({ transferId: null, issue: 'ledger_totals_unbalanced' });
  const perTransfer = transactionDb.prepare(`
    SELECT t.transfer_id, t.status, t.amount_cents,
      (SELECT count(*) FROM ledger_entry e WHERE e.transfer_id = t.transfer_id AND e.reverses_entry_id IS NULL AND e.direction = 'debit' AND e.amount_cents = t.amount_cents) AS debits,
      (SELECT count(*) FROM ledger_entry e WHERE e.transfer_id = t.transfer_id AND e.reverses_entry_id IS NULL AND e.direction = 'credit' AND e.amount_cents = t.amount_cents) AS credits,
      (SELECT count(*) FROM ledger_entry e WHERE e.transfer_id = t.transfer_id) AS entries
    FROM transfer t
    WHERE t.status = 'completed' OR EXISTS (SELECT 1 FROM ledger_entry e WHERE e.transfer_id = t.transfer_id)`).all();
  for (const r of perTransfer) {
    if (r.status !== 'completed') issues.push({ transferId: r.transfer_id, issue: 'postings_without_completion' });
    else if (r.debits !== 1 || r.credits !== 1 || r.entries !== 2) issues.push({ transferId: r.transfer_id, issue: 'completed_without_balanced_pair' });
  }
  return issues;
}

export function getOperationsOverview(viewer, { transactionDb, audit, now = Date.now() }) {
  assertSupport(viewer); // checked again here, close to the data
  audit.recordSupportAccess({ opsUserId: viewer.ops.opsUserId, eventType: SUPPORT_EVENTS.operationsView });

  const all = (sql, ...args) => transactionDb.prepare(sql).all(...args);
  const transfersByStatus = Object.fromEntries(all('SELECT status, count(*) AS n FROM transfer GROUP BY status').map((r) => [r.status, r.n]));
  const outbox = all('SELECT target, status, count(*) AS n FROM outbox_message GROUP BY target, status ORDER BY target, status')
    .map((r) => ({ target: r.target, status: r.status, count: r.n }));
  const parked = all(`SELECT transfer_id, target, attempts, last_error, updated_at FROM outbox_message
    WHERE status = 'dead' ORDER BY updated_at DESC LIMIT ?`, LIST_LIMIT)
    .map((r) => ({ transferId: r.transfer_id, target: r.target, attempts: r.attempts, lastError: (r.last_error ?? '').replace(/[^a-z0-9_:]/gi, '').slice(0, 60), at: r.updated_at }));
  const inFlight = all(`SELECT t.transfer_id, t.amount_cents, a.outcome, a.requested_at,
      (SELECT status FROM outbox_message m WHERE m.transfer_id = t.transfer_id AND m.target = 'settlement' ORDER BY m.rowid DESC LIMIT 1) AS message_status
    FROM transfer t JOIN settlement_attempt a ON a.transfer_id = t.transfer_id AND a.outcome IN ('pending', 'unknown')
    WHERE t.status = 'settlement_in_flight' ORDER BY a.requested_at LIMIT ?`, LIST_LIMIT)
    .map((r) => ({ transferId: r.transfer_id, amountCents: r.amount_cents, outcome: r.outcome, messageStatus: r.message_status ?? 'none', ageMs: Math.max(0, now - r.requested_at) }));
  const exceptions = all(`SELECT transfer_id, checked_at FROM reconciliation_result WHERE result = 'mismatched' ORDER BY checked_at DESC LIMIT ?`, LIST_LIMIT)
    .map((r) => ({ transferId: r.transfer_id, at: r.checked_at }));
  const reconciliations = all('SELECT transfer_id, result, checked_at FROM reconciliation_result ORDER BY checked_at DESC, rowid DESC LIMIT 20')
    .map((r) => ({ transferId: r.transfer_id, result: r.result, at: r.checked_at }));
  const events = all(`SELECT event_type, transfer_id, occurred_at FROM audit_event
    WHERE event_type IN (${OPERATIONAL_EVENTS.map(() => '?').join(', ')}) ORDER BY occurred_at DESC, rowid DESC LIMIT 20`, ...OPERATIONAL_EVENTS)
    .map((r) => ({ type: r.event_type, transferId: r.transfer_id, at: r.occurred_at }));
  const totals = transactionDb.prepare('SELECT debit_cents, credit_cents, entries FROM ledger_totals').get();
  const held = transactionDb.prepare(`SELECT coalesce(sum(amount_cents), 0) AS cents, count(*) AS n FROM transfer
    WHERE status IN ('pending_risk', 'pending_settlement', 'settlement_in_flight')`).get();
  const overdue = transactionDb.prepare(`SELECT count(*) AS n FROM transfer
    WHERE status IN ('pending_risk', 'pending_settlement') AND pending_expires_at <= ?`).get(now).n;

  return Object.freeze({
    generatedAt: now,
    transfersByStatus,
    outbox,
    parked,
    inFlight,
    exceptions,
    reconciliations,
    events,
    ledger: { debitCents: totals.debit_cents, creditCents: totals.credit_cents, entries: totals.entries, balanced: totals.debit_cents === totals.credit_cents },
    integrityIssues: ledgerIntegrityIssues(transactionDb),
    held: { cents: held.cents, transfers: held.n },
    overduePending: overdue,
  });
}
