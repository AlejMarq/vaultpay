// Settlement service (Step 7) – moves money for an approved transfer, once.
//
//   POST /v1/settlements
//   caller: the Orchestrator's settlement worker (mTLS, CN=vaultpay-orchestrator) – nobody else
//   body:   { "transfer": { id, sender_wallet_id, payee_type, payee_id, amount_cents, currency },
//             "idempotencyKey": "stlk_…",  "riskDecision": "<the stored fraud approval JWS>" }
//   200:    { "outcome": "settled", "postingRef": "MCBP-…" }   the bank confirmed the posting
//           { "outcome": "rejected", "reason": "…" }           the bank definitively refused
//           { "outcome": "refused", "reason": "…" }            not authorized before the bank
//                                                             (approval invalid, party inactive)
//           { "outcome": "not_sent" }                          Identity unreachable – this call
//                                                             never reached the bank
//           { "outcome": "unknown" }                           the bank may or may not have
//                                                             posted: retry with the SAME key
//   400:    { "error": "invalid_request" }
//
// Settlement holds no bank credential and names no bank account. It verifies the fraud
// approval itself (risk-decision PUBLIC key; bound to exactly this transfer), then asks
// Identity for a settlement token (Identity re-verifies the approval and maps the wallets
// to bank accounts from its own records), then presents that token – and nothing else – to
// CBI. Its own credentials: client certificate vaultpay-settlement (to Identity and CBI) and
// server certificate vaultpay-settlement (for the worker).

import { decodeJwt } from 'jose';
import { z } from 'zod';

import { ANY_REQUEST, RiskDecisionError, verifyRiskDecision } from '../../lib/fraud/risk-decision.js';
import { mtlsRequest } from '../../lib/services/mtls-request.js';
import { createServiceServer, readJsonBody, sendJson } from '../common/https-service.js';

export const SETTLEMENT_CLIENTS = Object.freeze(['vaultpay-orchestrator']);

const SettlementRequest = z.object({
  transfer: z.object({
    id: z.string().regex(/^trf_[A-Za-z0-9_]{1,60}$/),
    sender_wallet_id: z.string().regex(/^wal_[A-Za-z0-9_]{1,60}$/),
    payee_type: z.enum(['wallet', 'merchant']),
    payee_id: z.string().regex(/^(wal|mer)_[A-Za-z0-9_]{1,60}$/),
    amount_cents: z.number().int().min(1).max(1_000_000),
    currency: z.literal('USD'),
  }).strict(),
  idempotencyKey: z.string().regex(/^stlk_[0-9a-f]{24}$/),
  riskDecision: z.string().min(16).max(4096),
}).strict();

export function createSettlementServer({
  serverTls, clientTls, riskPublicKey, riskKeyId, identityPort, cbiPort,
  identityTimeoutMs = 3000, cbiTimeoutMs = 6000, now = () => Date.now(), log = () => {},
}) {
  const call = (port, expectedServer, options) => mtlsRequest({ port, expectedServer, credentials: clientTls, method: 'POST', ...options });

  async function settle(req, res) {
    const parsed = SettlementRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid_request' });
    const { transfer, idempotencyKey, riskDecision } = parsed.data;
    const answer = (body) => {
      log(`${transfer.id}: ${body.outcome}${body.reason ? ` (${body.reason})` : ''}`);
      return sendJson(res, 200, body);
    };

    // 1. The approval must be genuine, an approval, unexpired and for exactly this transfer.
    try {
      const d = await verifyRiskDecision(riskDecision, { publicKey: riskPublicKey, keyId: riskKeyId, expected: transfer, requestId: ANY_REQUEST, now: now() });
      if (d.outcome !== 'approve') return answer({ outcome: 'refused', reason: 'not_approved' });
    } catch (err) {
      if (err instanceof RiskDecisionError) return answer({ outcome: 'refused', reason: 'invalid_approval' });
      throw err;
    }

    // 2. A single-use token for exactly this posting, from Identity.
    let issued;
    try {
      issued = await call(identityPort, 'vaultpay-identity', { path: '/v1/service-tokens/settlement', body: { riskDecision, idempotencyKey }, timeoutMs: identityTimeoutMs });
    } catch {
      return answer({ outcome: 'not_sent' });
    }
    if (issued.status === 403) return answer({ outcome: 'refused', reason: 'not_authorized' });
    if (issued.status !== 200 || typeof issued.json?.token !== 'string') return answer({ outcome: 'not_sent' });
    // The token must name this transfer, amount and key (Identity chose the accounts).
    let claims;
    try {
      claims = decodeJwt(issued.json.token);
    } catch {
      return answer({ outcome: 'not_sent' });
    }
    if (claims.transfer_id !== transfer.id || claims.amount_cents !== transfer.amount_cents || claims.currency !== transfer.currency || claims.idempotency_key !== idempotencyKey) {
      return answer({ outcome: 'not_sent' });
    }

    // 3. CBI forwards exactly what the token names. From here on, silence means "unknown".
    let posted;
    try {
      posted = await call(cbiPort, 'vaultpay-cbi', { path: '/v1/postings', headers: { authorization: `Bearer ${issued.json.token}` }, timeoutMs: cbiTimeoutMs });
    } catch {
      return answer({ outcome: 'unknown' });
    }
    if (posted.status === 200 && posted.json?.outcome === 'posted' && /^MCBP-[0-9a-f]{20}$/.test(posted.json.postingRef ?? '')) {
      return answer({ outcome: 'settled', postingRef: posted.json.postingRef });
    }
    if (posted.status === 422 && posted.json?.outcome === 'rejected' && typeof posted.json.reason === 'string') {
      return answer({ outcome: 'rejected', reason: posted.json.reason.slice(0, 40) });
    }
    // CBI refused the token itself (before any bank call): this request did not reach the bank.
    if (posted.status === 401 || posted.status === 403) return answer({ outcome: 'not_sent' });
    return answer({ outcome: 'unknown' });
  }

  return createServiceServer({
    tls: serverTls,
    allowedClients: SETTLEMENT_CLIENTS,
    log,
    handle: async (req, res) => {
      if (req.url !== '/v1/settlements') return sendJson(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return settle(req, res);
    },
  });
}
