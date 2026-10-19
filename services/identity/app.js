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
//
// Step 7 adds exactly one more purpose, for exactly one more caller:
//
//   POST /v1/service-tokens/settlement   {"riskDecision": "<JWS>", "idempotencyKey": "stlk_…"}
//   caller: Settlement (mTLS, CN=vaultpay-settlement) – nobody else
//
// The caller chooses no account, amount, scope or audience. Identity verifies the fraud
// APPROVAL itself (signature, key, type, unexpired) and takes transfer id, sender, payee,
// amount and currency from its signed claims; the bank accounts come from Identity's own
// wallet/merchant records (active customer, active wallet or merchant). The token names
// exactly that one posting (debit account, credit account, amount, currency, idempotency
// key, transfer id), lives 30 s, is bound to Settlement's certificate and used once.
//
// Step 8 adds one read-only purpose for Reconciliation:
//
//   POST /v1/service-tokens/reconciliation
//        {"transferId","idempotencyKey","senderWalletId","payeeType","payeeId","amountCents","currency"}
//   caller: Reconciliation (mTLS, CN=vaultpay-recon) – nobody else
//
// The token (scope corebanking.records:read) lets CBI look up ONE posting by its
// idempotency key and compare it with the expected accounts (from Identity's records,
// whatever the wallet's status now), amount, currency and transfer id. It cannot post.

import { ANY_REQUEST, ANY_TRANSFER, RiskDecisionError, verifyRiskDecision } from '../../lib/fraud/risk-decision.js';
import { readMfaVerifiedAt } from '../../lib/server/dal.js';
import { SCOPES, signServiceToken } from '../../lib/services/service-token.js';
import { createServiceServer, readJsonBody, sendJson } from '../common/https-service.js';

export const IDENTITY_CLIENTS = Object.freeze(['vaultpay-web', 'vaultpay-settlement', 'vaultpay-recon']);
// Each endpoint has its own single caller.
const ROUTES = Object.freeze({
  '/v1/service-tokens/customer-balance': 'vaultpay-web',
  '/v1/service-tokens/settlement': 'vaultpay-settlement',
  '/v1/service-tokens/reconciliation': 'vaultpay-recon',
});
const RECON_FIELDS = 'amountCents,currency,idempotencyKey,payeeId,payeeType,senderWalletId,transferId';
const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
export const SETTLEMENT_KEY = /^stlk_[0-9a-f]{24}$/;

export function createIdentityServer({ tls, signingKey, keyId, identityDb, riskPublicKey, riskKeyId, now = () => Date.now(), log }) {
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

  // Settlement: accounts from Identity's own records, for active parties only.
  const senderAccount = identityDb.prepare(`SELECT w.core_account_ref FROM wallet w JOIN customer c ON c.customer_id = w.customer_id
    WHERE w.wallet_id = ? AND w.status = 'active' AND c.status = 'active'`);
  const merchantAccount = identityDb.prepare("SELECT core_account_ref FROM merchant WHERE merchant_id = ? AND status = 'active'");

  async function settlementToken(req, res, peer) {
    const body = await readJsonBody(req);
    const keys = body && typeof body === 'object' ? Object.keys(body).sort() : [];
    if (keys.join() !== 'idempotencyKey,riskDecision' || typeof body.riskDecision !== 'string' || typeof body.idempotencyKey !== 'string' || !SETTLEMENT_KEY.test(body.idempotencyKey)) {
      return sendJson(res, 400, { error: 'invalid_request' });
    }
    const refuse = (why) => {
      log?.(`settlement token refused: ${why}`);
      return sendJson(res, 403, { error: 'forbidden' });
    };
    const t = now();
    let decision;
    try {
      decision = await verifyRiskDecision(body.riskDecision, { publicKey: riskPublicKey, keyId: riskKeyId, expected: ANY_TRANSFER, requestId: ANY_REQUEST, now: t });
    } catch (err) {
      if (err instanceof RiskDecisionError) return refuse(`decision ${err.reason}`);
      throw err;
    }
    if (decision.outcome !== 'approve') return refuse('decision is not an approval');
    const trf = decision.transfer;
    const debit = senderAccount.get(trf.sender_wallet_id)?.core_account_ref;
    const credit = (trf.payee_type === 'wallet' ? senderAccount.get(trf.payee_id) : merchantAccount.get(trf.payee_id))?.core_account_ref;
    if (!debit || !credit || debit === credit) return refuse('party not active');

    const { token, expiresIn } = await signServiceToken({
      privateKey: signingKey,
      keyId,
      audience: 'vaultpay-cbi',
      subject: peer.subject.CN, // = vaultpay-settlement (the route's only caller)
      scope: SCOPES.settlementSubmit,
      clientCertDer: peer.raw,
      claims: {
        transfer_id: trf.id, debit_account: debit, credit_account: credit,
        amount_cents: trf.amount_cents, currency: trf.currency, idempotency_key: body.idempotencyKey, decision_id: decision.decisionId,
      },
      now: t,
    });
    return sendJson(res, 200, { token, expiresIn });
  }

  // Reconciliation: the accounts a posting for this transfer must have used.
  const anyWalletAccount = identityDb.prepare('SELECT core_account_ref FROM wallet WHERE wallet_id = ?');
  const anyMerchantAccount = identityDb.prepare('SELECT core_account_ref FROM merchant WHERE merchant_id = ?');

  async function reconciliationToken(req, res, peer) {
    const b = await readJsonBody(req);
    const ok = b && typeof b === 'object' && Object.keys(b).sort().join() === RECON_FIELDS
      && /^trf_[A-Za-z0-9_]{1,60}$/.test(b.transferId) && SETTLEMENT_KEY.test(b.idempotencyKey)
      && /^wal_[A-Za-z0-9_]{1,60}$/.test(b.senderWalletId) && ['wallet', 'merchant'].includes(b.payeeType)
      && (b.payeeType === 'wallet' ? /^wal_[A-Za-z0-9_]{1,60}$/ : /^mer_[A-Za-z0-9_]{1,60}$/).test(b.payeeId)
      && Number.isSafeInteger(b.amountCents) && b.amountCents >= 1 && b.amountCents <= 1_000_000 && b.currency === 'USD';
    if (!ok) return sendJson(res, 400, { error: 'invalid_request' });
    const debit = anyWalletAccount.get(b.senderWalletId)?.core_account_ref;
    const credit = (b.payeeType === 'wallet' ? anyWalletAccount.get(b.payeeId) : anyMerchantAccount.get(b.payeeId))?.core_account_ref;
    if (!debit || !credit || debit === credit) {
      log?.('reconciliation token refused: unknown party');
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const { token, expiresIn } = await signServiceToken({
      privateKey: signingKey,
      keyId,
      audience: 'vaultpay-cbi',
      subject: peer.subject.CN, // = vaultpay-recon
      scope: SCOPES.recordsRead,
      clientCertDer: peer.raw,
      claims: { transfer_id: b.transferId, idempotency_key: b.idempotencyKey, debit_account: debit, credit_account: credit, amount_cents: b.amountCents, currency: b.currency },
      now: now(),
    });
    return sendJson(res, 200, { token, expiresIn });
  }

  const HANDLERS = { 'vaultpay-web': customerBalanceToken, 'vaultpay-settlement': settlementToken, 'vaultpay-recon': reconciliationToken };

  return createServiceServer({
    tls,
    allowedClients: IDENTITY_CLIENTS,
    log,
    handle: async (req, res, peer) => {
      const caller = ROUTES[req.url];
      if (!caller) return sendJson(res, 404, { error: 'not_found' });
      if (peer.subject.CN !== caller) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return HANDLERS[caller](req, res, peer);
    },
  });
}
