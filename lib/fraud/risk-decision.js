// Signed risk decisions (Step 6, threat 82).
//
// Fraud & Risk Check is the only holder of the risk-decision signing key (fraud.env). A
// decision is a compact JWS (jose, EdDSA) that binds:
//   - the exact transfer: id, sender wallet, payee type and id, amount, currency
//   - the outcome (approve | decline), an integer risk score and reason codes
//   - the screening request it answers (`req`: outbox message id + attempt), so a decision
//     from an earlier request cannot be replayed as the answer to a later one
//   - a unique decision id (`jti` = risk_decision.decision_id), issued-at and expiry
// The Orchestrator's worker verifies every one of these against ITS OWN database row
// before applying it; the decision id is a primary key, so a decision applies once.
// Same style as lib/services/service-token.js (fixed issuer, audience and type), but a
// different key and type, so a service token can never pass as a decision or vice versa.

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export const DECISION_ISSUER = 'vaultpay-fraud';
export const DECISION_AUDIENCE = 'vaultpay-orchestrator';
export const DECISION_TYPE = 'vaultpay-risk-decision+jwt';
// Long enough for Step 7 to settle; Settlement must check `exp` again (re-screen otherwise).
export const DECISION_LIFETIME_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 5;

const TransferBinding = z.object({
  id: z.string().regex(/^trf_[A-Za-z0-9_]{1,60}$/),
  sender_wallet_id: z.string().regex(/^wal_[A-Za-z0-9_]{1,60}$/),
  payee_type: z.enum(['wallet', 'merchant']),
  payee_id: z.string().regex(/^(wal|mer)_[A-Za-z0-9_]{1,60}$/),
  amount_cents: z.number().int().min(1).max(1_000_000),
  currency: z.literal('USD'),
}).strict();

const DecisionClaims = z.object({
  iss: z.literal(DECISION_ISSUER),
  aud: z.literal(DECISION_AUDIENCE),
  sub: z.string(),
  jti: z.string().regex(/^rsk_[0-9a-f]{24}$/),
  iat: z.number().int(),
  exp: z.number().int(),
  req: z.string().min(1).max(128),
  transfer: TransferBinding,
  outcome: z.enum(['approve', 'decline']),
  risk_score: z.number().int().min(0).max(1000),
  reasons: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(10),
}).strict();

export class RiskDecisionError extends Error {
  constructor(reason) {
    super(`risk decision rejected: ${reason}`);
    this.name = 'RiskDecisionError';
    this.reason = reason;
  }
}

/** The transfer fields a decision binds, taken from a transaction-DB `transfer` row. */
export const bindingOf = (row) => ({
  id: row.transfer_id,
  sender_wallet_id: row.sender_wallet_id,
  payee_type: row.payee_type,
  payee_id: row.payee_id,
  amount_cents: row.amount_cents,
  currency: row.currency,
});

/** Fraud & Risk Check only. */
export async function signRiskDecision({ privateKey, keyId, decisionId, requestId, transfer, outcome, riskScore, reasons, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ req: requestId, transfer, outcome, risk_score: riskScore, reasons })
    .setProtectedHeader({ alg: 'EdDSA', typ: DECISION_TYPE, kid: keyId })
    .setIssuer(DECISION_ISSUER)
    .setAudience(DECISION_AUDIENCE)
    .setSubject(transfer.id)
    .setIssuedAt(iat)
    .setExpirationTime(iat + DECISION_LIFETIME_SECONDS)
    .setJti(decisionId)
    .sign(privateKey);
}

// Explicit opt-outs (never the default): Settlement and Identity re-verify a STORED approval
// after the screening request is over (ANY_REQUEST); Identity, which has no transaction
// database, reads the transfer from the signed claims themselves (ANY_TRANSFER).
export const ANY_REQUEST = Symbol('any screening request');
export const ANY_TRANSFER = Symbol('transfer taken from the signed claims');

const sameBinding = (a, b) => Object.keys(b).length === Object.keys(a).length && Object.keys(a).every((k) => a[k] === b[k]);

/**
 * Verifies a decision for `expected` (bindingOf(the DB row)) and the request it must answer.
 * Returns { decisionId, outcome, riskScore, reasons, issuedAt, expiresAt, keyId } or throws
 * RiskDecisionError – a decision that fails any check is never applied.
 */
export async function verifyRiskDecision(jws, { publicKey, keyId, expected, requestId, now = Date.now() }) {
  if (typeof jws !== 'string' || jws.length === 0 || jws.length > 4096) throw new RiskDecisionError('missing');
  let payload;
  let protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(jws, publicKey, {
      algorithms: ['EdDSA'],
      typ: DECISION_TYPE,
      issuer: DECISION_ISSUER,
      audience: DECISION_AUDIENCE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      maxTokenAge: `${DECISION_LIFETIME_SECONDS}s`,
      requiredClaims: ['iat', 'exp', 'jti', 'sub'],
      currentDate: new Date(now),
    }));
  } catch (err) {
    throw new RiskDecisionError(err.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid_signature');
  }
  if (protectedHeader.kid !== keyId) throw new RiskDecisionError('unknown_key');
  const parsed = DecisionClaims.safeParse(payload);
  if (!parsed.success) throw new RiskDecisionError('malformed');
  const c = parsed.data;
  if (c.exp - c.iat > DECISION_LIFETIME_SECONDS || c.exp <= c.iat) throw new RiskDecisionError('bad_lifetime');
  if (requestId !== ANY_REQUEST && c.req !== requestId) throw new RiskDecisionError('wrong_request');
  if (c.sub !== c.transfer.id) throw new RiskDecisionError('wrong_transfer');
  if (expected !== ANY_TRANSFER && (c.sub !== expected?.id || !sameBinding(c.transfer, expected))) throw new RiskDecisionError('wrong_transfer');
  return Object.freeze({
    decisionId: c.jti, outcome: c.outcome, riskScore: c.risk_score, reasons: Object.freeze([...c.reasons]),
    issuedAt: c.iat * 1000, expiresAt: c.exp * 1000, keyId: protectedHeader.kid, transfer: Object.freeze({ ...c.transfer }),
  });
}
