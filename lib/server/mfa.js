// TOTP enrollment and second-factor verification, shared by the /mfa Server Actions and
// the tests. Everything runs through Better Auth 1.7.10's two-factor plugin
// (enableTwoFactor, verifyTOTP, verifyBackupCode, viewBackupCodes); this module adds
// input checks, rate limiting and the rules below. It never creates its own MFA state:
// the session marker is set by Better Auth's session hook (lib/server/auth-config.js).
//
// Rules:
//   - Enrollment needs a signed-in, password-only session for an account WITHOUT TOTP,
//     plus the password again. An account that already has TOTP can never be re-enrolled
//     from a password-only session (that would let a password alone replace the second
//     factor).
//   - Enrollment completes only after the first code from the new secret verifies;
//     Better Auth then replaces the session with one carrying mfaVerifiedAt.
//   - Backup codes are fetched only after that, and returned once.
//   - trustDevice is never passed, so no trusted-device cookie is ever issued.
//   - Every TOTP code is claimed in the replay guard (lib/server/totp-replay.js) before
//     Better Auth sees it, so one code completes at most one verification.

import QRCode from 'qrcode';

import { getAuthContext } from './auth.js';
import { TWO_FACTOR_COOKIE } from './auth-config.js';
import { AccessDenied } from './dal.js';
import { clientKey, createMfaRateLimiter, rateLimitedMessageFor } from './rate-limit.js';
import { createTotpReplayGuard } from './totp-replay.js';

export const INVALID_CODE = 'That code is not valid. Check your authenticator app and try again.';
export const INVALID_BACKUP_CODE = 'That backup code is not valid or has already been used.';
export const INCORRECT_PASSWORD = 'Incorrect password.';
export const ALREADY_ENROLLED = 'Two-factor authentication is already set up for this account. Sign out and sign in again with your authenticator code.';
export const CHALLENGE_EXPIRED = 'Your sign-in has expired. Please sign in again.';
export const CHALLENGE_EXHAUSTED = 'Too many incorrect codes. Please sign in again.';
export const ACCOUNT_LOCKED = 'Too many incorrect codes. Try again in 15 minutes.';

const TOTP_CODE = /^\d{6}$/;
const BACKUP_CODE = /^[A-Za-z0-9-]{8,32}$/;
const MAX_PASSWORD_LENGTH = 128;

const errorCode = (err) => err?.body?.code ?? err?.code;
const isApiRejection = (err) => err?.name === 'APIError' && Number(err.statusCode) >= 400 && Number(err.statusCode) < 500;

function requirePendingViewer(viewer) {
  if (!viewer) throw new AccessDenied('no-session');
  if (viewer.mfa.verified) throw new AccessDenied('already-verified');
}

/** Groups a base32 secret as "ABCD EFGH …" for manual entry. */
const groupKey = (secret) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * Step 1: password re-entry, then Better Auth generates a new TOTP secret (not active yet).
 * Returns { ok: true, qrDataUrl, manualKey } or { ok: false, error }.
 */
export async function startEnrollment({ auth, viewer, headers, password, limiter }) {
  requirePendingViewer(viewer);
  if (viewer.mfa.enrolled) return { ok: false, error: ALREADY_ENROLLED };

  const client = clientKey(headers);
  const gate = limiter.check(client, viewer.userId);
  if (!gate.allowed) return { ok: false, error: rateLimitedMessageFor(gate.retryAfterSeconds), rateLimited: true };

  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    limiter.recordFailure(client, viewer.userId);
    return { ok: false, error: INCORRECT_PASSWORD };
  }
  let totpURI;
  try {
    ({ totpURI } = await auth.api.enableTwoFactor({ body: { password }, headers }));
  } catch (err) {
    if (!isApiRejection(err)) throw err;
    limiter.recordFailure(client, viewer.userId);
    return { ok: false, error: INCORRECT_PASSWORD };
  }
  // Backup codes returned here are deliberately discarded: they are shown only after the
  // first TOTP code proves the authenticator works (confirmEnrollment).

  const uri = new URL(totpURI);
  const secret = uri.searchParams.get('secret');
  if (uri.protocol !== 'otpauth:' || !/^[A-Z2-7]+=*$/.test(secret ?? '')) throw new Error('unexpected TOTP URI from Better Auth');
  const qrDataUrl = await QRCode.toDataURL(totpURI, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { ok: true, qrDataUrl, manualKey: groupKey(secret) };
}

/**
 * Step 2: the first code from the new secret. On success Better Auth enables TOTP and
 * issues a NEW session (with mfaVerifiedAt); backup codes are returned once.
 * Returns { ok: true, backupCodes, headers } or { ok: false, error }.
 */
export async function confirmEnrollment({ auth, viewer, headers, code, limiter, replayGuard }) {
  if (!replayGuard) throw new Error('confirmEnrollment: replayGuard is required');
  requirePendingViewer(viewer);
  if (viewer.mfa.enrolled) return { ok: false, error: ALREADY_ENROLLED };

  const client = clientKey(headers);
  const gate = limiter.check(client, viewer.userId);
  if (!gate.allowed) return { ok: false, error: rateLimitedMessageFor(gate.retryAfterSeconds), rateLimited: true };

  const value = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!TOTP_CODE.test(value)) {
    limiter.recordFailure(client, viewer.userId);
    return { ok: false, error: INVALID_CODE };
  }
  const claim = replayGuard.claim(viewer.userId, value);
  if (!claim) {
    limiter.recordFailure(client, viewer.userId);
    return { ok: false, error: INVALID_CODE };
  }
  let result;
  try {
    result = await auth.api.verifyTOTP({ body: { code: value }, headers, returnHeaders: true });
  } catch (err) {
    claim.release();
    if (!isApiRejection(err)) throw err;
    limiter.recordFailure(client, viewer.userId);
    return { ok: false, error: errorCode(err) === 'ACCOUNT_TEMPORARILY_LOCKED' ? ACCOUNT_LOCKED : INVALID_CODE };
  }
  limiter.recordSuccess(client, viewer.userId);
  const { backupCodes } = await auth.api.viewBackupCodes({ body: { userId: viewer.userId } });
  return { ok: true, backupCodes, headers: result.headers };
}

/** The pending sign-in challenge id from Better Auth's signed two-factor cookie, or null. */
export function challengeIdFrom(headers) {
  const raw = headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== TWO_FACTOR_COOKIE) continue;
    let value;
    try {
      value = decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
    const dot = value.lastIndexOf('.'); // "<identifier>.<signature>"
    return dot > 0 ? value.slice(0, dot) : null;
  }
  return null;
}

/**
 * Sign-in challenge (no session yet, only Better Auth's two-factor cookie): a TOTP code
 * or a one-time backup code. On success Better Auth creates the session (with
 * mfaVerifiedAt). Returns { ok: true, headers } or { ok: false, error, restart? }.
 *
 * Rate limiting is keyed by the user the challenge belongs to (looked up read-only from
 * Better Auth's verification table), so starting a new challenge does not reset it.
 */
export async function verifyChallenge({ auth, identityDb, headers, method, code, limiter, replayGuard }) {
  if (!replayGuard) throw new Error('verifyChallenge: replayGuard is required');
  const challengeId = challengeIdFrom(headers);
  if (!challengeId) return { ok: false, error: CHALLENGE_EXPIRED, restart: true };
  const owner = identityDb.prepare('SELECT value FROM verification WHERE identifier = ?').get(challengeId)?.value;
  const subject = owner ? `user:${owner}` : 'challenge:unknown';

  const client = clientKey(headers);
  const gate = limiter.check(client, subject);
  if (!gate.allowed) return { ok: false, error: rateLimitedMessageFor(gate.retryAfterSeconds), rateLimited: true };

  const isBackup = method === 'backup';
  const value = typeof code === 'string' ? (isBackup ? code.trim() : code.replace(/\s+/g, '')) : '';
  const invalid = isBackup ? INVALID_BACKUP_CODE : INVALID_CODE;
  if (!(isBackup ? BACKUP_CODE : TOTP_CODE).test(value)) {
    limiter.recordFailure(client, subject);
    return { ok: false, error: invalid };
  }
  // Backup codes are single-use in Better Auth itself; TOTP codes are claimed here first.
  // Without a known owner the challenge is invalid anyway, and Better Auth rejects it.
  const claim = !isBackup && owner ? replayGuard.claim(owner, value) : { release() {} };
  if (!claim) {
    limiter.recordFailure(client, subject);
    return { ok: false, error: invalid };
  }
  try {
    const call = isBackup ? auth.api.verifyBackupCode : auth.api.verifyTOTP;
    const result = await call({ body: { code: value }, headers, returnHeaders: true });
    limiter.recordSuccess(client, subject);
    return { ok: true, headers: result.headers };
  } catch (err) {
    claim.release();
    if (!isApiRejection(err)) throw err;
    limiter.recordFailure(client, subject);
    switch (errorCode(err)) {
      case 'INVALID_TWO_FACTOR_COOKIE':
        return { ok: false, error: CHALLENGE_EXPIRED, restart: true };
      case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
        return { ok: false, error: CHALLENGE_EXHAUSTED, restart: true };
      case 'ACCOUNT_TEMPORARILY_LOCKED':
        return { ok: false, error: ACCOUNT_LOCKED };
      default:
        return { ok: false, error: invalid };
    }
  }
}

const LIMITER = Symbol.for('vaultpay.mfa-rate-limiter');
const REPLAY_GUARD = Symbol.for('vaultpay.totp-replay-guard');

/** The process-wide replay guard, on Better Auth's (writable) identity connection. */
export async function totpReplayGuard() {
  globalThis[REPLAY_GUARD] ??= getAuthContext().then(({ db }) => createTotpReplayGuard(db)).catch((err) => {
    delete globalThis[REPLAY_GUARD];
    throw err;
  });
  return globalThis[REPLAY_GUARD];
}

/** The process-wide MFA limiter used by the Server Actions. */
export function mfaRateLimiter() {
  globalThis[LIMITER] ??= createMfaRateLimiter();
  return globalThis[LIMITER];
}
