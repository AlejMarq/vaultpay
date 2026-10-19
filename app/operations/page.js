import Link from 'next/link';

import { auditWriter } from '@/lib/server/audit';
import { getOperationsOverview } from '@/lib/server/operations';
import { readOnlyTransactionDb, requireSupport } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../session-controls';
import { formatUsd, STATUS_LABELS } from '../transfer-table';

// Read-only operations overview (Step 8). requireSupport(): MFA completed in this session,
// an active support_readonly ops user. Read-only connection; viewing is audited before any
// data is shown. There is deliberately no form, button or Server Action here besides
// signing out – recovery runs only as `npm run reconcile` on the server (docs/SETUP.md).
export const instant = false;

export const metadata = { title: 'Operations – VaultPay' };

// Next renders this page twice while answering one full page load (observed: two audit rows
// per GET; React cache() does not span the two passes). One view is recorded per session
// within VIEW_DEDUPE_MS – always BEFORE the first data of that view is returned, and a
// failing audit write still stops the page. The map only suppresses duplicates; it never
// grants access (requireSupport runs on every render).
const VIEW_DEDUPE_MS = 2000;
const recentViews = new Map(); // session id → time of the last recorded view
function auditOncePerView(sessionId) {
  return Object.freeze({
    recordSupportAccess(event) {
      const t = Date.now();
      if (t - (recentViews.get(sessionId) ?? 0) < VIEW_DEDUPE_MS) return null;
      const id = auditWriter().recordSupportAccess(event);
      recentViews.set(sessionId, t);
      if (recentViews.size > 1000) for (const [k, at] of recentViews) if (t - at > VIEW_DEDUPE_MS) recentViews.delete(k);
      return id;
    },
  });
}

const when = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const minutes = (ms) => `${Math.floor(ms / 60_000)} min`;

function Table({ head, rows, empty, label }) {
  if (rows.length === 0) return <p className="muted" data-empty={label}>{empty}</p>;
  return (
    <table className="transfers" data-table={label}>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((cells, i) => <tr key={i}>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

export default async function OperationsPage() {
  const viewer = await requireSupport();
  const o = getOperationsOverview(viewer, { transactionDb: readOnlyTransactionDb(), audit: auditOncePerView(viewer.session.id) });
  const statuses = Object.keys(STATUS_LABELS);
  return (
    <main className="page">
      <SessionKeepAlive />
      <header className="topbar">
        <h1>Operations (read-only)</h1>
        <SignOutButton />
      </header>
      <p className="muted">As of {when(o.generatedAt)} UTC. Monitoring only – recovery and reconciliation run on the server.</p>

      <section className="stack">
        <h2>Transfers by status</h2>
        <Table label="status" head={['Status', 'Count']} empty="No transfers."
          rows={statuses.map((s) => [<span key={s} data-count-status={s}>{STATUS_LABELS[s]}</span>, <span key={`${s}n`} data-count={s}>{o.transfersByStatus[s] ?? 0}</span>])} />
        <p>Reserved (not final): <strong data-held={o.held.cents}>{formatUsd(o.held.cents)}</strong> in {o.held.transfers} transfer(s).
          Overdue pending (awaiting expiry): <strong data-overdue={o.overduePending}>{o.overduePending}</strong>.</p>
      </section>

      <section className="stack">
        <h2>Outbox</h2>
        <Table label="outbox" head={['Target', 'Status', 'Messages']} empty="No outbox messages."
          rows={o.outbox.map((m) => [m.target, m.status, m.count])} />
        <h3>Parked messages</h3>
        <Table label="parked" head={['Transfer', 'Target', 'Attempts', 'Last error', 'Parked at']} empty="No parked messages."
          rows={o.parked.map((p) => [<code key="t">{p.transferId}</code>, p.target, p.attempts, p.lastError, when(p.at)])} />
      </section>

      <section className="stack">
        <h2>Reconciliation</h2>
        <h3>Settlements with an open outcome</h3>
        <Table label="in-flight" head={['Transfer', 'Amount', 'Bank outcome', 'Settlement message', 'Age']} empty="None – every settlement has a confirmed outcome."
          rows={o.inFlight.map((f) => [<code key="t">{f.transferId}</code>, formatUsd(f.amountCents), f.outcome, f.messageStatus, minutes(f.ageMs)])} />
        <h3>Exceptions (bank record differs – investigate)</h3>
        <Table label="exceptions" head={['Transfer', 'Found at']} empty="No reconciliation exceptions."
          rows={o.exceptions.map((e) => [<code key="t">{e.transferId}</code>, when(e.at)])} />
        <h3>Recent reconciliation results</h3>
        <Table label="results" head={['Transfer', 'Result', 'Checked at']} empty="No reconciliation results yet."
          rows={o.reconciliations.map((r) => [<code key="t">{r.transferId}</code>, r.result, when(r.at)])} />
      </section>

      <section className="stack">
        <h2>Ledger integrity</h2>
        <p data-ledger-balanced={String(o.ledger.balanced)}>
          Debits {formatUsd(o.ledger.debitCents)} · Credits {formatUsd(o.ledger.creditCents)} · {o.ledger.entries} entries –{' '}
          <strong>{o.ledger.balanced ? 'balanced' : 'NOT BALANCED'}</strong>
        </p>
        <Table label="integrity" head={['Transfer', 'Issue']} empty="No integrity issues."
          rows={o.integrityIssues.map((i) => [i.transferId ? <code key="t">{i.transferId}</code> : '—', i.issue])} />
      </section>

      <section className="stack">
        <h2>Recent operational events</h2>
        <Table label="events" head={['Event', 'Transfer', 'At']} empty="No operational events yet."
          rows={o.events.map((e) => [e.type, e.transferId ? <code key="t">{e.transferId}</code> : '—', when(e.at)])} />
      </section>

      <p><Link href="/support">Back to customer support</Link></p>
    </main>
  );
}
