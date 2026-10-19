// Money handling for transfers: integer cents only, never floating-point arithmetic.

export const CURRENCY = 'USD';
export const MIN_TRANSFER_CENTS = 1; // $0.01
// Business limit per transfer (D16 keeps it separate from the database's $10,000 ceiling).
export const MAX_TRANSFER_CENTS = 100_000; // $1,000.00

const AMOUNT = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/;

/**
 * Parses a user-entered USD amount ("12", "12.5", "12.50") into integer cents by string
 * manipulation. Returns null for anything else: signs, exponents, separators, more than two
 * decimals, leading zeros, whitespace inside, non-strings.
 */
export function parseUsdToCents(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^\$/, '');
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const dollars = Number(m[1]);
  const cents = m[2] ? Number(m[2].slice(1).padEnd(2, '0')) : 0;
  return dollars * 100 + cents;
}

/** Integer cents → "$1,234.56". */
export function formatCents(cents) {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}
