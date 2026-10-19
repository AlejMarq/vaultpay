// Identity service (Step 4B) – the only process that holds the service-token signing key.
//
// It issues exactly one kind of token, for exactly one caller:
//
//   POST /v1/service-tokens/customer-balance   {"sessionToken": "<Better Auth session token>"}
//   caller: Next.js (mTLS, CN=vaultpay-web) – nobody else
//
// Nothing in the request chooses the token's audience, subject, scope or account. Identity
// validates the customer's session in its OWN (read-only) copy of the identity database –
// live, MFA completed in that session, an active customer, an active wallet – and takes the
// bank account from that wallet's record. The token is bound to the caller's certificate,
// lives 30 seconds and can be used once. A compromised Next.js therefore cannot obtain a
// balance token for a customer who is not signed in with MFA.

import { readMfaVerifiedAt } from '../../lib/server/dal.js';
import { SCOPES, signServiceToken } from '../../lib/services/service-token.js';
import { createServiceServer, readJsonBody, sendJson } from '../common/https-service.js';

export const IDENTITY_CLIENTS = Object.freeze(['vaultpay-web']);
const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function createIdentityServer({ tls, signingKey, keyId, identityDb, now = () => Date.now(), log }) {
  const sessionByToken = identityDb.prepare('SELECT id, userId, expiresAt, createdAt, mfaVerifiedAt FROM session WHERE token = ?');
  const customerByUser = identityDb.prepare('SELECT customer_id, status FROM customer WHERE auth_user_id = ?');
  // Same wallet as the web DAL shows (oldest), which must be active.
  const walletOf = identityDb.prepare('SELECT wallet_id, status, core_account_ref FROM wallet WHERE customer_id = ? ORDER BY created_at LIMIT 1');

  async function customerBalanceToken(req, res, peer) {
    const body = await readJsonBody(req);
    const keys = body && typeof body === 'object' ? Object.keys(body) : [];
    if (keys.length !== 1 || keys[0] !== 'sessionToken' || typeof body.sessionToken !== 'string' || !SESSION_TOKEN.test(body.sessionToken)) {
      return sendJson(res, 400, { error: 'invalid_request' });
    }
    // Every refusal below is the same generic 403: the caller learns nothing about why.
    const refuse = () => sendJson(res, 403, { error: 'forbidden' });
    const t = now();
    const session = sessionByToken.get(body.sessionToken);
    if (!session || !(Date.parse(session.expiresAt) > t)) return refuse();
    if (!readMfaVerifiedAt(session)) return refuse();
    const customer = customerByUser.get(session.userId);
    if (!customer || customer.status !== 'active') return refuse();
    const wallet = walletOf.get(customer.customer_id);
    if (!wallet || wallet.status !== 'active') return refuse();

    const { token, expiresIn } = await signServiceToken({
      privateKey: signingKey,
      keyId,
      audience: 'vaultpay-cbi',
      subject: peer.subject.CN, // = vaultpay-web (the allowlist)
      scope: SCOPES.balanceRead,
      clientCertDer: peer.raw,
      claims: { account_ref: wallet.core_account_ref, wallet_id: wallet.wallet_id },
      now: t,
    });
    return sendJson(res, 200, { token, expiresIn });
  }

  return createServiceServer({
    tls,
    allowedClients: IDENTITY_CLIENTS,
    log,
    handle: async (req, res, peer) => {
      if (req.url !== '/v1/service-tokens/customer-balance') return sendJson(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return customerBalanceToken(req, res, peer);
    },
  });
}
