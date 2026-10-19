// Transfer eligibility (Step 3, Section 3E) – the KYC and wallet rules a customer must
// meet before moving money. Used by the /send page now, and by Step 5's transfer
// operations, which must call assertVerifiedCustomer() again immediately before creating
// a transfer.
//
// readEligibility() always queries the identity database at the moment it is called; it
// never trusts the viewer snapshot taken at the start of the request, so a KYC decision,
// a frozen wallet or a suspension made in between still applies.

import { AccessDenied, assertCustomer } from './dal.js';

// Why a customer may not send money. Codes are stable; Step 5 can rely on them.
export const INELIGIBLE = Object.freeze({
  customerInactive: 'customer_inactive',
  kycNotStarted: 'kyc_not_started',
  kycPending: 'kyc_pending',
  kycRejected: 'kyc_rejected',
  noWallet: 'no_wallet',
  walletFrozen: 'wallet_frozen',
  walletClosed: 'wallet_closed',
});

const KYC_REASON = { pending: INELIGIBLE.kycPending, rejected: INELIGIBLE.kycRejected };

/**
 * The customer's current eligibility, straight from the database:
 * { eligible, reasons: [...codes], walletId, kycStatus }.
 * Eligible means: active customer, an active wallet owned by them, latest KYC approved.
 */
export function readEligibility(identityDb, customerId) {
  const customer = identityDb.prepare(`
    SELECT c.status, k.status AS kyc_status
    FROM customer c
    LEFT JOIN customer_current_kyc k ON k.customer_id = c.customer_id
    WHERE c.customer_id = ?`).get(customerId);
  if (!customer) return Object.freeze({ eligible: false, reasons: [INELIGIBLE.customerInactive], walletId: null, kycStatus: null });

  const wallet = identityDb.prepare(`
    SELECT wallet_id, status FROM wallet
    WHERE customer_id = ?
    ORDER BY (status = 'active') DESC, created_at
    LIMIT 1`).get(customerId);

  const reasons = [];
  if (customer.status !== 'active') reasons.push(INELIGIBLE.customerInactive);
  const kyc = customer.kyc_status ?? 'not_started';
  if (kyc !== 'approved') reasons.push(KYC_REASON[kyc] ?? INELIGIBLE.kycNotStarted);
  if (!wallet) reasons.push(INELIGIBLE.noWallet);
  else if (wallet.status === 'frozen') reasons.push(INELIGIBLE.walletFrozen);
  else if (wallet.status !== 'active') reasons.push(INELIGIBLE.walletClosed);

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    walletId: wallet?.status === 'active' ? wallet.wallet_id : null,
    kycStatus: kyc,
  });
}

/**
 * The guard behind requireVerifiedCustomer(): an MFA-verified session of an active
 * customer (assertCustomer) who is eligible right now. Throws AccessDenied('not-eligible')
 * with the reason codes in `details`. Returns { viewer, eligibility }.
 */
export function assertVerifiedCustomer(viewer, identityDb) {
  assertCustomer(viewer);
  const eligibility = readEligibility(identityDb, viewer.customer.customerId);
  if (!eligibility.eligible) throw new AccessDenied('not-eligible', eligibility.reasons);
  return { viewer, eligibility };
}
