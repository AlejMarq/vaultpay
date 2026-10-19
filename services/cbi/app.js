// Core Banking Integration (CBI) service (Step 4B) – the only VaultPay process that talks
// to Core Banking and the only holder of the Core Banking credential.
//
//   GET /v1/balance        Authorization: Bearer <service token>
//   caller: Next.js (mTLS, CN=vaultpay-web) with an Identity-issued token
//
// The request names no account. CBI reads the balance only of the account named inside
// an Identity-signed token that is: for audience vaultpay-cbi, issued to this very caller
// (sub = TLS peer CN, cnf = TLS peer certificate), of scope corebanking.balance:read,
// unexpired, at most 60 s old, and not used before. The balance comes from Core Banking
// over mTLS (lib/cbi/core-banking-client.js).

import { ACCOUNT_REF_PATTERN, CoreBankingError } from '../../lib/cbi/core-banking-client.js';
import { SCOPES, ServiceTokenError, verifyServiceToken } from '../../lib/services/service-token.js';
import { createServiceServer, sendJson } from '../common/https-service.js';

export const CBI_CLIENTS = Object.freeze(['vaultpay-web']);
const ALLOWED_SCOPES = Object.freeze({ 'vaultpay-web': [SCOPES.balanceRead] });
const WALLET_ID = /^wal_[A-Za-z0-9_]{1,60}$/;

export function createCbiServer({ tls, tokenPublicKey, keyId, bank, replayCache, now = () => Date.now(), log }) {
  async function balance(req, res, peer) {
    const auth = req.headers.authorization ?? '';
    let claims;
    try {
      claims = await verifyServiceToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', {
        publicKey: tokenPublicKey,
        keyId,
        audience: 'vaultpay-cbi',
        peerCertificate: peer,
        allowedScopes: ALLOWED_SCOPES,
        requiredClaims: ['account_ref', 'wallet_id'],
        replayCache,
        now: now(),
      });
    } catch (err) {
      if (err instanceof ServiceTokenError) {
        log?.(`token refused: ${err.reason}`);
        return sendJson(res, err.reason === 'scope not allowed' ? 403 : 401, { error: err.reason === 'scope not allowed' ? 'forbidden' : 'unauthorized' });
      }
      throw err;
    }
    if (claims.scope !== SCOPES.balanceRead || !ACCOUNT_REF_PATTERN.test(claims.account_ref) || !WALLET_ID.test(claims.wallet_id)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    try {
      const b = await bank.getBalance(claims.account_ref);
      return sendJson(res, 200, { walletId: claims.wallet_id, balanceCents: b.balanceCents, currency: b.currency, status: b.status, asOf: b.asOf });
    } catch (err) {
      if (!(err instanceof CoreBankingError)) throw err;
      log?.(`core banking: ${err.code}`);
      return err.code === 'unavailable' ? sendJson(res, 503, { error: 'unavailable' }) : sendJson(res, 502, { error: 'upstream_error' });
    }
  }

  return createServiceServer({
    tls,
    allowedClients: CBI_CLIENTS,
    log,
    handle: async (req, res, peer) => {
      if (req.url !== '/v1/balance') return sendJson(res, req.url?.startsWith('/v1/balance') ? 400 : 404, { error: req.url?.startsWith('/v1/balance') ? 'invalid_request' : 'not_found' });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return balance(req, res, peer);
    },
  });
}
