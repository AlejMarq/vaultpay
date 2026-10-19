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
//
//   POST /v1/postings      Authorization: Bearer <service token>, NO body   (Step 7)
//   caller: Settlement (mTLS, CN=vaultpay-settlement) with an Identity-issued token of
//   scope corebanking.settlement:submit
//
// The request carries nothing but the token: CBI forwards exactly the posting the token
// names (debit account, credit account, amount, currency, idempotency key, transfer id).
//   200 {outcome:"posted", postingRef}       the bank confirmed (also for a repeat)
//   422 {outcome:"rejected", reason}         the bank definitively refused; nothing moved
//   504 {outcome:"unknown"}                  no answer / bank error: retry with the SAME key
//
//   POST /v1/postings/lookup   Authorization: Bearer <service token>, NO body   (Step 8)
//   caller: Reconciliation (mTLS, CN=vaultpay-recon), scope corebanking.records:read
//   Read-only: asks the bank for the posting with the token's idempotency key and compares
//   it with the token's transfer id, accounts, amount and currency. Never returns accounts.
//   200 {status:"posted", postingRef} | {status:"not_found"} | {status:"mismatch"}
//   504 {status:"unknown"}                   bank unavailable or invalid answer

import { ACCOUNT_REF_PATTERN, CoreBankingError } from '../../lib/cbi/core-banking-client.js';
import { SCOPES, ServiceTokenError, verifyServiceToken } from '../../lib/services/service-token.js';
import { createServiceServer, sendJson } from '../common/https-service.js';

export const CBI_CLIENTS = Object.freeze(['vaultpay-web', 'vaultpay-settlement', 'vaultpay-recon']);
const ALLOWED_SCOPES = Object.freeze({
  'vaultpay-web': [SCOPES.balanceRead],
  'vaultpay-settlement': [SCOPES.settlementSubmit],
  'vaultpay-recon': [SCOPES.recordsRead],
});
const LOOKUP_CLAIMS = ['transfer_id', 'debit_account', 'credit_account', 'amount_cents', 'currency', 'idempotency_key'];
const WALLET_ID = /^wal_[A-Za-z0-9_]{1,60}$/;
const SETTLEMENT_CLAIMS = ['transfer_id', 'debit_account', 'credit_account', 'amount_cents', 'currency', 'idempotency_key', 'decision_id'];

export function createCbiServer({ tls, tokenPublicKey, keyId, bank, replayCache, now = () => Date.now(), log }) {
  // Verifies the bearer token for this caller; answers 401/403 itself and returns null on refusal.
  async function tokenClaims(req, res, peer, requiredClaims) {
    const auth = req.headers.authorization ?? '';
    try {
      return await verifyServiceToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', {
        publicKey: tokenPublicKey,
        keyId,
        audience: 'vaultpay-cbi',
        peerCertificate: peer,
        allowedScopes: ALLOWED_SCOPES,
        requiredClaims,
        replayCache,
        now: now(),
      });
    } catch (err) {
      if (err instanceof ServiceTokenError) {
        log?.(`token refused: ${err.reason}`);
        sendJson(res, err.reason === 'scope not allowed' ? 403 : 401, { error: err.reason === 'scope not allowed' ? 'forbidden' : 'unauthorized' });
        return null;
      }
      throw err;
    }
  }

  async function balance(req, res, peer) {
    const claims = await tokenClaims(req, res, peer, ['account_ref', 'wallet_id']);
    if (!claims) return undefined;
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

  async function posting(req, res, peer) {
    // No body: every posting detail comes from the signed token.
    if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') return sendJson(res, 400, { error: 'invalid_request' });
    if (req.headers['transfer-encoding'] !== undefined) return sendJson(res, 400, { error: 'invalid_request' });
    const claims = await tokenClaims(req, res, peer, SETTLEMENT_CLAIMS);
    if (!claims) return undefined;
    const ok = claims.scope === SCOPES.settlementSubmit && peer.subject.CN === 'vaultpay-settlement'
      && ACCOUNT_REF_PATTERN.test(claims.debit_account) && ACCOUNT_REF_PATTERN.test(claims.credit_account) && claims.debit_account !== claims.credit_account
      && Number.isSafeInteger(claims.amount_cents) && claims.amount_cents >= 1 && claims.amount_cents <= 1_000_000 && claims.currency === 'USD'
      && /^stlk_[0-9a-f]{24}$/.test(claims.idempotency_key) && /^trf_[A-Za-z0-9_]{1,60}$/.test(claims.transfer_id);
    if (!ok) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const r = await bank.postTransfer({
        idempotencyKey: claims.idempotency_key, debitAccount: claims.debit_account, creditAccount: claims.credit_account,
        amountCents: claims.amount_cents, currency: claims.currency, reference: claims.transfer_id,
      });
      log?.(`posting ${claims.transfer_id}: ${r.outcome}${r.replayed ? ' (repeat)' : ''}`);
      return r.outcome === 'posted'
        ? sendJson(res, 200, { outcome: 'posted', postingRef: r.postingRef })
        : sendJson(res, 422, { outcome: 'rejected', reason: r.reason });
    } catch (err) {
      if (!(err instanceof CoreBankingError)) throw err;
      log?.(`posting ${claims.transfer_id}: outcome unknown (${err.code})`);
      return sendJson(res, 504, { outcome: 'unknown' });
    }
  }

  async function lookup(req, res, peer) {
    if ((req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] !== undefined) {
      return sendJson(res, 400, { error: 'invalid_request' });
    }
    const claims = await tokenClaims(req, res, peer, LOOKUP_CLAIMS);
    if (!claims) return undefined;
    if (claims.scope !== SCOPES.recordsRead || peer.subject.CN !== 'vaultpay-recon' || !/^stlk_[0-9a-f]{24}$/.test(claims.idempotency_key)
      || !ACCOUNT_REF_PATTERN.test(claims.debit_account) || !ACCOUNT_REF_PATTERN.test(claims.credit_account)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    try {
      const p = await bank.getPosting(claims.idempotency_key);
      if (!p) return sendJson(res, 200, { status: 'not_found' });
      const same = p.reference === claims.transfer_id && p.debitAccount === claims.debit_account && p.creditAccount === claims.credit_account
        && p.amountCents === claims.amount_cents && p.currency === claims.currency;
      log?.(`lookup ${claims.transfer_id}: ${same ? 'posted' : 'mismatch'}`);
      return sendJson(res, 200, same ? { status: 'posted', postingRef: p.postingRef } : { status: 'mismatch' });
    } catch (err) {
      if (!(err instanceof CoreBankingError)) throw err;
      log?.(`lookup ${claims.transfer_id}: unknown (${err.code})`);
      return sendJson(res, 504, { status: 'unknown' });
    }
  }

  return createServiceServer({
    tls,
    allowedClients: CBI_CLIENTS,
    log,
    handle: async (req, res, peer) => {
      if (req.url === '/v1/postings/lookup') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        if (peer.subject.CN !== 'vaultpay-recon') return sendJson(res, 403, { error: 'forbidden' });
        return lookup(req, res, peer);
      }
      if (req.url === '/v1/postings') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        if (peer.subject.CN !== 'vaultpay-settlement') return sendJson(res, 403, { error: 'forbidden' });
        return posting(req, res, peer);
      }
      if (peer.subject.CN !== 'vaultpay-web') return sendJson(res, 403, { error: 'forbidden' });
      if (req.url !== '/v1/balance') return sendJson(res, req.url?.startsWith('/v1/balance') ? 400 : 404, { error: req.url?.startsWith('/v1/balance') ? 'invalid_request' : 'not_found' });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return balance(req, res, peer);
    },
  });
}
