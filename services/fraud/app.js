// Fraud & Risk Check service (Step 6) – the only process that holds the risk-decision
// signing key. Stateless: it opens no database and keeps nothing between requests.
//
//   POST /v1/risk-decisions
//   caller: the Orchestrator's outbox worker (mTLS, CN=vaultpay-orchestrator) – nobody else
//   body:   { "requestId": "<outbox message id>:<attempt>",
//             "transfer": { id, sender_wallet_id, payee_type, payee_id, amount_cents, currency },
//             "createdAt": <ms> }
//   200:    { "decision": "<compact JWS>" }   (approve or decline, both signed)
//   400:    { "error": "invalid_request" }     (not scored, nothing signed)
//
// The decision is computed by the deterministic engine and bound to exactly the transfer
// fields and request id received (lib/fraud/risk-decision.js). The worker compares that
// binding with its own database row, so a caller cannot get one transfer's approval
// applied to another.

import crypto from 'node:crypto';

import { z } from 'zod';

import { assessTransfer } from '../../lib/fraud/engine.js';
import { signRiskDecision } from '../../lib/fraud/risk-decision.js';
import { createServiceServer, readJsonBody, sendJson } from '../common/https-service.js';

export const FRAUD_CLIENTS = Object.freeze(['vaultpay-orchestrator']);

const ScreeningRequest = z.object({
  requestId: z.string().regex(/^obx_[0-9a-f]{24}:[0-9]{1,4}$/),
  transfer: z.object({
    id: z.string().regex(/^trf_[A-Za-z0-9_]{1,60}$/),
    sender_wallet_id: z.string().regex(/^wal_[A-Za-z0-9_]{1,60}$/),
    payee_type: z.enum(['wallet', 'merchant']),
    payee_id: z.string().regex(/^(wal|mer)_[A-Za-z0-9_]{1,60}$/),
    amount_cents: z.number().int().min(1).max(1_000_000),
    currency: z.literal('USD'),
  }).strict(),
  createdAt: z.number().int().positive(),
}).strict();

export function createFraudServer({ tls, signingKey, keyId, config, now = () => Date.now(), log = () => {} }) {
  return createServiceServer({
    tls,
    allowedClients: FRAUD_CLIENTS,
    log,
    handle: async (req, res) => {
      if (req.url !== '/v1/risk-decisions') return sendJson(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const parsed = ScreeningRequest.safeParse(await readJsonBody(req));
      if (!parsed.success) return sendJson(res, 400, { error: 'invalid_request' });
      const { requestId, transfer, createdAt } = parsed.data;
      if (transfer.payee_type === 'merchant' ? !transfer.payee_id.startsWith('mer_') : !transfer.payee_id.startsWith('wal_')) {
        return sendJson(res, 400, { error: 'invalid_request' });
      }
      const t = now();
      const assessment = assessTransfer(transfer, createdAt, config, t);
      const decision = await signRiskDecision({
        privateKey: signingKey, keyId,
        decisionId: `rsk_${crypto.randomBytes(12).toString('hex')}`,
        requestId, transfer, outcome: assessment.outcome, riskScore: assessment.riskScore, reasons: assessment.reasons, now: t,
      });
      log(`decision ${assessment.outcome} for ${transfer.id}${assessment.reasons.length ? ` (${assessment.reasons.join(', ')})` : ''}`);
      return sendJson(res, 200, { decision });
    },
  });
}
