// Read-only transfer history table (used by /wallet and /support). Plain component with
// no server-only code, so it renders in both Server and Client Components.

export const KYC_LABELS = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected', not_started: 'Not started' };

// Integer cents only (no floating-point arithmetic on money).
export const formatUsd = (cents) => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;

// Customer-facing transfer status. Nothing before "completed" is final.
export const STATUS_LABELS = {
  pending_risk: 'Pending – security check',
  pending_settlement: 'Pending – awaiting settlement',
  settlement_in_flight: 'Processing',
  completed: 'Completed',
  declined: 'Declined',
  failed: 'Failed',
  expired: 'Expired',
};

export function TransferTable({ transfers }) {
  if (transfers.length === 0) return <p className="muted">No transfers yet.</p>;
  return (
    <table className="transfers">
      <thead>
        <tr><th>Date</th><th>Direction</th><th>Counterparty</th><th>Amount</th><th>Status</th><th>Reference</th></tr>
      </thead>
      <tbody>
        {transfers.map((t) => (
          <tr key={t.transferId}>
            <td>{new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td>{t.direction === 'sent' ? 'Sent' : 'Received'}</td>
            <td>{t.counterparty.label}</td>
            <td>{t.direction === 'sent' ? '−' : '+'}{formatUsd(t.amountCents)}</td>
            <td data-status={t.status}>{STATUS_LABELS[t.status] ?? t.status}</td>
            <td><code>{t.transferId}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
