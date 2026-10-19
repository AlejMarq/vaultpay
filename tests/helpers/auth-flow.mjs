// Test helpers for signed-in sessions on a temporary installation: password login,
// TOTP enrollment (MFA-verified session) and viewer resolution – all through the same
// library functions the Server Actions use.

import assert from 'node:assert/strict';

import { createAuth } from '../../lib/server/auth.js';
import { resolveViewer } from '../../lib/server/dal.js';
import { openIdentityDb, openTransactionDb } from '../../lib/server/db/index.js';
import { attemptLogin } from '../../lib/server/login.js';
import { confirmEnrollment, startEnrollment, verifyChallenge } from '../../lib/server/mfa.js';
import { createLoginRateLimiter, createMfaRateLimiter } from '../../lib/server/rate-limit.js';
import { createTotpReplayGuard } from '../../lib/server/totp-replay.js';
import { onCleanup } from './db.mjs';
import { freshInstall } from './setup.mjs';
import { totp } from './totp.mjs';

const LOCAL = { 'x-forwarded-for': '127.0.0.1' };

/** A browser-like cookie jar (Max-Age=0 deletes). */
export function cookieJar() {
  const cookies = new Map();
  return {
    apply(headers) {
      for (const sc of headers?.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = sc.split(';');
        const [name, ...v] = pair.split('=');
        if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) cookies.delete(name.trim());
        else cookies.set(name.trim(), v.join('='));
      }
    },
    headers: () => new Headers({ ...LOCAL, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
  };
}

export async function authHarness(t) {
  const { dataDir } = await freshInstall(t);
  const { auth, db, close } = await createAuth({ dataDir });
  const identityRo = openIdentityDb({ dataDir, readonly: true });
  const transactionRo = openTransactionDb({ dataDir, readonly: true });
  const transactionRw = openTransactionDb({ dataDir });
  onCleanup(t, () => { transactionRw.close(); transactionRo.close(); identityRo.close(); close(); });

  const limiters = { login: createLoginRateLimiter(), mfa: createMfaRateLimiter() };
  const replayGuard = createTotpReplayGuard(db);

  const passwordLogin = async (user) => {
    const browser = cookieJar();
    const r = await attemptLogin({ auth, limiter: limiters.login, headers: browser.headers(), email: user.email, password: user.password });
    assert.equal(r.ok, true, `${user.email} password login`);
    browser.apply(r.headers);
    return { browser, twoFactor: r.twoFactor };
  };
  const viewerOf = (browser) => resolveViewer({ auth, identityDb: identityRo, headers: browser.headers() });

  /** First login + TOTP enrollment → an MFA-verified session. */
  const verifiedLogin = async (user) => {
    const { browser } = await passwordLogin(user);
    const viewer = await viewerOf(browser);
    const started = await startEnrollment({ auth, viewer, headers: browser.headers(), password: user.password, limiter: limiters.mfa });
    assert.equal(started.ok, true, started.error);
    const secret = started.manualKey.replaceAll(' ', '');
    const enrollmentCode = totp(secret);
    const done = await confirmEnrollment({ auth, viewer, headers: browser.headers(), code: enrollmentCode, limiter: limiters.mfa, replayGuard });
    assert.equal(done.ok, true, done.error);
    browser.apply(done.headers);
    return { browser, viewer: await viewerOf(browser), secret, enrollmentCode, backupCodes: done.backupCodes };
  };

  /** A sign-in challenge answered with `code` (TOTP) for an enrolled user. */
  const challenge = async (user, code, method = 'totp') => {
    const { browser } = await passwordLogin(user);
    const r = await verifyChallenge({ auth, identityDb: identityRo, headers: browser.headers(), method, code, limiter: limiters.mfa, replayGuard });
    if (r.ok) browser.apply(r.headers);
    return { ...r, browser };
  };

  return { dataDir, auth, identityDb: db, identityRo, transactionRo, transactionRw, replayGuard, limiters, passwordLogin, viewerOf, verifiedLogin, challenge };
}
