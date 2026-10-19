// Read-only transfer history for one wallet, shared by the customer wallet page and the
// support view. Callers pass the wallet id from an authorization check – never from a
// request – and read-only connections.

export const RECENT_TRANSFER_LIMIT = 20;

/** Most recent transfers sent or received by `walletId`, newest first. */
export function recentTransfers({ transactionDb, identityDb, walletId, limit = RECENT_TRANSFER_LIMIT }) {
  const rows = transactionDb.prepare(`
    SELECT transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, currency, status, created_at
    FROM transfer
    WHERE sender_wallet_id = ? OR (payee_type = 'wallet' AND payee_id = ?)
    ORDER BY created_at DESC, transfer_id DESC
    LIMIT ?`).all(walletId, walletId, limit);

  const merchantName = identityDb.prepare('SELECT display_name FROM merchant WHERE merchant_id = ?');
  return rows.map((r) => {
    const sent = r.sender_wallet_id === walletId;
    const counterparty = sent
      ? { type: r.payee_type, id: r.payee_id, label: r.payee_type === 'merchant' ? (merchantName.get(r.payee_id)?.display_name ?? r.payee_id) : r.payee_id }
      : { type: 'wallet', id: r.sender_wallet_id, label: r.sender_wallet_id };
    return Object.freeze({
      transferId: r.transfer_id,
      direction: sent ? 'sent' : 'received',
      counterparty: Object.freeze(counterparty),
      amountCents: r.amount_cents,
      currency: r.currency,
      status: r.status,
      createdAt: new Date(r.created_at),
    });
  });
}
