// Read-only customer lookup for support_readonly ops users (threat 244).
//
// - Reads use read-only connections; this module has no write path to customer, wallet,
//   KYC or transfer data.
// - Contact details are masked; only what dispute resolution needs is returned.
// - Every search, and every customer view it leads to, is recorded by the separate
//   append-only audit writer BEFORE any data is returned. If auditing fails, nothing is
//   shown (fail closed).
// - Only customers can be looked up: an email belonging to an ops user, or to nobody,
//   gives the same "not found".

import { assertSupport } from './dal.js';
import { SUPPORT_EVENTS } from './audit.js';
import { normalizeEmail } from './rate-limit.js';
import { recentTransfers } from './transfers.js';

/** "alice@example.test" → "a***e@example.test" */
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 1 ? local[local.length - 1] : ''}${email.slice(at)}`;
}

/** "+1-555-0101" → "+•-•••-••01" (keeps separators and the last two digits) */
export function maskPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').length;
  let seen = 0;
  return phone.replace(/\d/g, (d) => (++seen > digits - 2 ? d : '•'));
}

export function lookupCustomer(viewer, email, { identityDb, transactionDb, audit }) {
  assertSupport(viewer); // checked again here, close to the data
  const opsUserId = viewer.ops.opsUserId;
  const normalized = normalizeEmail(email);

  const row = normalized
    ? identityDb.prepare(`
        SELECT c.customer_id, c.full_name, c.contact_phone, c.status, u.email,
               k.status AS kyc_status, w.wallet_id, w.status AS wallet_status
        FROM "user" u
        JOIN customer c ON c.auth_user_id = u.id
        LEFT JOIN customer_current_kyc k ON k.customer_id = c.customer_id
        LEFT JOIN wallet w ON w.customer_id = c.customer_id
        WHERE u.email = ?
        ORDER BY w.created_at
        LIMIT 1`).get(normalized)
    : undefined;

  audit.recordSupportAccess({ opsUserId, eventType: SUPPORT_EVENTS.search });
  if (!row) return Object.freeze({ found: false });

  const transfers = row.wallet_id ? recentTransfers({ transactionDb, identityDb, walletId: row.wallet_id }) : [];
  audit.recordSupportAccess({ opsUserId, eventType: SUPPORT_EVENTS.view, subjectWalletId: row.wallet_id ?? null });

  return Object.freeze({
    found: true,
    customer: Object.freeze({
      customerId: row.customer_id,
      fullName: row.full_name,
      maskedEmail: maskEmail(row.email),
      maskedPhone: maskPhone(row.contact_phone),
      status: row.status,
      kycStatus: row.kyc_status ?? 'not_started',
    }),
    wallet: row.wallet_id ? Object.freeze({ walletId: row.wallet_id, status: row.wallet_status }) : null,
    transfers,
  });
}
