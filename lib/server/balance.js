// Customer balance for the /wallet page (Step 4B), Next.js side.
//
// Next.js holds no signing key and no Core Banking credential, and never names a bank
// account. It (1) checks the viewer is an active, MFA-verified customer with an active
// wallet, (2) asks Identity for a single-use balance token by presenting the customer's own
// session over mTLS (CN=vaultpay-web), and (3) presents that token to CBI over the same
// kind of connection. Identity decides the account from its own records; CBI accepts only
// the account inside the token. The page receives only the balance or "unavailable" – never
// a token, account reference or internal error.

import { z } from 'zod';

import { assertCustomer } from './dal.js';
import { mtlsRequest } from '../services/mtls-request.js';

const CbiBalance = z.object({
  walletId: z.string(),
  balanceCents: z.number().int().min(0),
  currency: z.literal('USD'),
  status: z.enum(['active', 'frozen', 'closed']),
  asOf: z.iso.datetime(),
}).strict();

/** The opaque token from a Better Auth session cookie value ("<token>.<signature>"), or null. */
export function sessionTokenFromCookie(value) {
  if (typeof value !== 'string' || value === '') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const dot = decoded.lastIndexOf('.');
  const token = dot > 0 ? decoded.slice(0, dot) : '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

const unavailable = (reason) => Object.freeze({ available: false, reason });

/**
 * Returns { available: true, balanceCents, currency, status, asOf } or
 * { available: false, reason } (the reason is for the server log only).
 */
export async function fetchCustomerBalance(viewer, { sessionToken, credentials, identityPort, cbiPort, timeoutMs = 3000 }) {
  assertCustomer(viewer); // MFA in this session, an active customer
  const wallet = viewer.customer.wallet;
  if (!wallet || wallet.status !== 'active') return unavailable('wallet_inactive');
  if (!sessionToken) return unavailable('no_session_token');
  try {
    const issued = await mtlsRequest({
      port: identityPort, method: 'POST', path: '/v1/service-tokens/customer-balance',
      credentials, expectedServer: 'vaultpay-identity', body: { sessionToken }, timeoutMs,
    });
    if (issued.status !== 200 || typeof issued.json?.token !== 'string') return unavailable(`identity_${issued.status}`);

    const res = await mtlsRequest({
      port: cbiPort, path: '/v1/balance',
      credentials, expectedServer: 'vaultpay-cbi', headers: { authorization: `Bearer ${issued.json.token}` }, timeoutMs,
    });
    if (res.status !== 200) return unavailable(`cbi_${res.status}`);
    const parsed = CbiBalance.safeParse(res.json);
    if (!parsed.success) return unavailable('cbi_bad_response');
    if (parsed.data.walletId !== wallet.walletId) return unavailable('wallet_mismatch');
    const { balanceCents, currency, status, asOf } = parsed.data;
    return Object.freeze({ available: true, balanceCents, currency, status, asOf });
  } catch (err) {
    return unavailable(err.code ?? 'error');
  }
}
