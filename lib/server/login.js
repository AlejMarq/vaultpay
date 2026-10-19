// Password login, shared by the /login Server Action and the tests.
//
// - One generic message for every credential problem (unknown email, wrong password,
//   malformed input), so the response never reveals whether an account exists. Better
//   Auth also hashes a dummy password for unknown emails, so timing matches.
// - Rate limited before Better Auth is called (lib/server/rate-limit.js).
// - A correct password for an account with TOTP enrolled creates NO session: Better Auth
//   returns a challenge instead (completed in Section 3C).

import { clientKey, createLoginRateLimiter, normalizeEmail } from './rate-limit.js';

export const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';
export const rateLimitedMessage = (seconds) =>
  `Too many sign-in attempts. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).`;

const MAX_PASSWORD_LENGTH = 128; // Better Auth's default maximum

const isCredentialRejection = (err) =>
  err?.name === 'APIError' && (err.statusCode === 401 || err.statusCode === 400 || err.status === 'UNAUTHORIZED' || err.status === 'BAD_REQUEST');

/**
 * Returns { ok: false, error, rateLimited? } or { ok: true, twoFactor, headers }.
 * Unexpected failures (database down, misconfiguration) are thrown, never reported as
 * a credential error.
 */
export async function attemptLogin({ auth, limiter, headers, email, password }) {
  const client = clientKey(headers);
  const normalized = normalizeEmail(email);

  const gate = limiter.check(client, normalized);
  if (!gate.allowed) return { ok: false, error: rateLimitedMessage(gate.retryAfterSeconds), rateLimited: true };

  if (!normalized || typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    limiter.recordFailure(client, normalized);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  let result;
  try {
    result = await auth.api.signInEmail({ body: { email: normalized, password, rememberMe: true }, headers, returnHeaders: true });
  } catch (err) {
    if (!isCredentialRejection(err)) throw err;
    limiter.recordFailure(client, normalized);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }
  limiter.recordSuccess(client, normalized);
  return { ok: true, twoFactor: result.response?.twoFactorRedirect === true, headers: result.headers };
}

const LIMITER = Symbol.for('vaultpay.login-rate-limiter');

/** The process-wide limiter used by the Server Action. */
export function loginRateLimiter() {
  globalThis[LIMITER] ??= createLoginRateLimiter();
  return globalThis[LIMITER];
}
