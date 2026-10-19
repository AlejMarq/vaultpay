// Service tokens (Step 4B, docs/SERVICE_AUTH.md): short-lived, single-use, Identity-signed
// JWS that say what one VaultPay service may do at another, for one request.
//
// Only the Identity service process holds the signing key; receivers hold the public key.
// This module is deliberately not a general token framework: tokens are issued by
// purpose-specific functions with fixed issuer, audience, subject and scope, and every
// receiver states exactly what it accepts.

import crypto from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

export const ISSUER = 'vaultpay-identity';
export const TOKEN_TYPE = 'vaultpay-service+jwt';
export const TOKEN_LIFETIME_SECONDS = 30;
export const MAX_TOKEN_AGE_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

export const SCOPES = Object.freeze({ balanceRead: 'corebanking.balance:read' });

// Keys as stored in the env files (base64url DER: PKCS#8 private, SPKI public).
export const privateKeyFrom = (value) => crypto.createPrivateKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'pkcs8' });
export const publicKeyFrom = (value) => crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });

/** SHA-256 thumbprint of a DER certificate, base64url (RFC 8705 `x5t#S256`). */
export const certificateThumbprint = (der) => crypto.createHash('sha256').update(der).digest('base64url');

export class ServiceTokenError extends Error {
  constructor(reason) {
    super(`service token rejected: ${reason}`);
    this.name = 'ServiceTokenError';
    this.reason = reason;
  }
}

/**
 * Signs a token. `claims` are the purpose-specific claims chosen by the Identity service
 * itself (never copied from a request). Returns { token, jti, expiresIn }.
 */
export async function signServiceToken({ privateKey, keyId, audience, subject, scope, clientCertDer, claims = {}, now = Date.now() }) {
  const jti = crypto.randomBytes(16).toString('base64url');
  const iat = Math.floor(now / 1000);
  const token = await new SignJWT({ ...claims, scope, cnf: { 'x5t#S256': certificateThumbprint(clientCertDer) } })
    .setProtectedHeader({ alg: 'EdDSA', typ: TOKEN_TYPE, kid: keyId })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + TOKEN_LIFETIME_SECONDS)
    .setJti(jti)
    .sign(privateKey);
  return { token, jti, expiresIn: TOKEN_LIFETIME_SECONDS };
}

/** Remembers token ids until they expire; bounded. A second use of a jti is refused. */
export function createReplayCache({ maxEntries = 10_000, now = () => Date.now() } = {}) {
  const seen = new Map(); // jti → expiry (ms)
  return {
    /** True the first time a jti is used (and records it); false on any reuse. */
    use(jti, expiresAtMs) {
      const t = now();
      for (const [k, exp] of seen) {
        if (exp > t) break; // insertion order ≈ expiry order (fixed lifetimes)
        seen.delete(k);
      }
      if (seen.has(jti)) return false;
      if (seen.size >= maxEntries) return false; // fail closed rather than forget a token
      seen.set(jti, expiresAtMs);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * Verifies a token presented over mTLS. Checks, in order: signature with the expected key
 * id, alg EdDSA, typ; issuer, audience, expiry and maximum age; subject = the TLS peer's
 * CN; certificate binding = the TLS peer's certificate; scope allowed for that subject;
 * required claims; single use. Returns the payload or throws ServiceTokenError.
 */
export async function verifyServiceToken(token, {
  publicKey, keyId, audience, peerCertificate, allowedScopes, requiredClaims = [], replayCache, now = Date.now(),
}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) throw new ServiceTokenError('missing');
  let payload;
  let protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
      typ: TOKEN_TYPE,
      issuer: ISSUER,
      audience,
      maxTokenAge: `${MAX_TOKEN_AGE_SECONDS}s`,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['iat', 'exp', 'jti', 'sub', 'scope', 'cnf', ...requiredClaims],
      currentDate: new Date(now),
    }));
  } catch (err) {
    throw new ServiceTokenError(err.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid');
  }
  if (protectedHeader.kid !== keyId) throw new ServiceTokenError('unknown key');
  if (payload.exp - payload.iat > MAX_TOKEN_AGE_SECONDS) throw new ServiceTokenError('lifetime too long');

  const peerCn = peerCertificate?.subject?.CN;
  if (!peerCn || payload.sub !== peerCn) throw new ServiceTokenError('subject does not match the caller');
  if (!peerCertificate.raw || payload.cnf?.['x5t#S256'] !== certificateThumbprint(peerCertificate.raw)) {
    throw new ServiceTokenError('not bound to the caller\'s certificate');
  }
  if (!(allowedScopes[payload.sub] ?? []).includes(payload.scope)) throw new ServiceTokenError('scope not allowed');
  if (!replayCache.use(payload.jti, payload.exp * 1000 + CLOCK_SKEW_SECONDS * 1000)) throw new ServiceTokenError('replayed');
  return payload;
}
