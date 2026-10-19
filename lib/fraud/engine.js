// Mock fraud engine (Step 6) – deterministic rules, no randomness, no outside data, so the
// demo always gives the same answer for the same transfer.
//
//   decline  amount ≥ declineAtCents (default $250.00)          reason amount_over_limit
//   decline  payee is the sender's own wallet                    reason same_wallet
//   decline  payee wallet on the demo block list                 reason blocked_payee
//   decline  transfer created in the future or older than 24 h   reason implausible_time
//   approve  everything else; risk score grows with the amount (0–499)
// Structurally invalid requests are not scored at all (the service answers 400).
//
// Thresholds are demo settings, read from the Fraud process's environment (not secrets):
//   VAULTPAY_FRAUD_DECLINE_AT_CENTS   e.g. 25000
//   VAULTPAY_FRAUD_BLOCKED_PAYEES     comma-separated wallet ids

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;
export const DEFAULT_DECLINE_AT_CENTS = 25_000;

export function engineConfig(env = process.env) {
  const raw = env.VAULTPAY_FRAUD_DECLINE_AT_CENTS;
  const declineAtCents = raw === undefined || raw === '' ? DEFAULT_DECLINE_AT_CENTS : Number(raw);
  if (!Number.isSafeInteger(declineAtCents) || declineAtCents < 1 || declineAtCents > 1_000_000) {
    throw new Error('VAULTPAY_FRAUD_DECLINE_AT_CENTS must be a whole number of cents between 1 and 1000000');
  }
  const blockedPayees = (env.VAULTPAY_FRAUD_BLOCKED_PAYEES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (blockedPayees.some((p) => !/^(wal|mer)_[A-Za-z0-9_]{1,60}$/.test(p))) throw new Error('VAULTPAY_FRAUD_BLOCKED_PAYEES must list wallet or merchant ids');
  return Object.freeze({ declineAtCents, blockedPayees: Object.freeze(blockedPayees) });
}

/** `transfer`: the request's transfer (already schema-checked), `createdAt` in ms. */
export function assessTransfer(transfer, createdAt, config, now = Date.now()) {
  const reasons = [];
  if (transfer.amount_cents >= config.declineAtCents) reasons.push('amount_over_limit');
  if (transfer.payee_type === 'wallet' && transfer.payee_id === transfer.sender_wallet_id) reasons.push('same_wallet');
  if (config.blockedPayees.includes(transfer.payee_id)) reasons.push('blocked_payee');
  if (createdAt > now + CLOCK_SKEW_MS || createdAt < now - DAY_MS) reasons.push('implausible_time');

  if (reasons.length > 0) return Object.freeze({ outcome: 'decline', riskScore: Math.min(1000, 900 + 25 * (reasons.length - 1)), reasons: Object.freeze(reasons) });
  // Integer arithmetic only: 0 for tiny amounts, 499 just below the decline threshold.
  const riskScore = Math.floor((transfer.amount_cents * 499) / config.declineAtCents);
  return Object.freeze({ outcome: 'approve', riskScore, reasons: Object.freeze([]) });
}
