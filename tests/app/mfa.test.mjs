import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAuth } from '../../lib/server/auth.js';
import { assertMfaVerified, landingPath, resolveViewer } from '../../lib/server/dal.js';
import { openIdentityDb } from '../../lib/server/db/index.js';
import { attemptLogin } from '../../lib/server/login.js';
import {
  ALREADY_ENROLLED, CHALLENGE_EXHAUSTED, CHALLENGE_EXPIRED, challengeIdFrom, confirmEnrollment,
  INCORRECT_PASSWORD, INVALID_BACKUP_CODE, INVALID_CODE, startEnrollment, verifyChallenge,
} from '../../lib/server/mfa.js';
import { createLoginRateLimiter, createMfaRateLimiter } from '../../lib/server/rate-limit.js';
import { createTotpReplayGuard } from '../../lib/server/totp-replay.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';
import { totp } from '../helpers/totp.mjs';

const [alice, bob] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;
const LOCAL = { 'x-forwarded-for': '127.0.0.1' };

// Cookie jar: applies Set-Cookie headers like a browser (Max-Age=0 deletes).
function jar() {
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
    has: (name) => cookies.has(name),
  };
}

async function setup(t) {
  const { dataDir } = await freshInstall(t);
  const { auth, db, close } = await createAuth({ dataDir });
  const ro = openIdentityDb({ dataDir, readonly: true });
  onCleanup(t, () => { ro.close(); close(); });
  const mfaLimiter = createMfaRateLimiter();
  const loginLimiter = createLoginRateLimiter();
  const replayGuard = createTotpReplayGuard(db);

  const login = async (user, browser = jar()) => {
    const r = await attemptLogin({ auth, limiter: loginLimiter, headers: browser.headers(), email: user.email, password: user.password });
    assert.equal(r.ok, true, `${user.email} password login`);
    browser.apply(r.headers);
    return { browser, twoFactor: r.twoFactor };
  };
  const viewerOf = (browser) => resolveViewer({ auth, identityDb: ro, headers: browser.headers() });

  // Full first-login enrollment; returns the browser, the TOTP secret and the backup codes.
  const enroll = async (user) => {
    const { browser } = await login(user);
    const viewer = await viewerOf(browser);
    const started = await startEnrollment({ auth, viewer, headers: browser.headers(), password: user.password, limiter: mfaLimiter, replayGuard });
    assert.equal(started.ok, true, started.error);
    const secret = started.manualKey.replaceAll(' ', '');
    const done = await confirmEnrollment({ auth, viewer, headers: browser.headers(), code: totp(secret), limiter: mfaLimiter, replayGuard });
    assert.equal(done.ok, true, done.error);
    browser.apply(done.headers);
    return { browser, secret, backupCodes: done.backupCodes, started };
  };

  const challenge = async (user, method, code, browser) => {
    const b = browser ?? (await login(user)).browser;
    const r = await verifyChallenge({ auth, identityDb: ro, headers: b.headers(), method, code, limiter: mfaLimiter, replayGuard });
    if (r.ok) b.apply(r.headers);
    return { ...r, browser: b };
  };

  return { auth, db, ro, login, viewerOf, enroll, challenge, mfaLimiter, replayGuard };
}

const sessions = (db, userEmail) => db.prepare(`SELECT s.id, s.mfaVerifiedAt FROM session s JOIN "user" u ON u.id = s.userId WHERE u.email = ? ORDER BY s.createdAt`).all(userEmail);

// ---------------------------------------------------------------------------
test('first-login enrollment: password, QR code + key, first code, backup codes, MFA-verified session', async (t) => {
  const { db, viewerOf, enroll } = await setup(t);
  const { browser, secret, backupCodes, started } = await enroll(alice);

  assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(started.manualKey, /^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
  assert.ok(secret.length >= 16);
  assert.equal(backupCodes.length, 10);
  assert.ok(backupCodes.every((c) => typeof c === 'string' && c.length >= 8));

  const v = await viewerOf(browser);
  assert.equal(v.mfa.enrolled, true);
  assert.equal(v.mfa.verified, true, 'the new session carries mfaVerifiedAt');
  assert.ok(v.mfa.verifiedAt instanceof Date);
  assert.equal(assertMfaVerified(v), v);
  assert.equal(landingPath(v), '/wallet', 'an MFA-verified customer lands on the wallet');
  // Better Auth replaced the password-only session: exactly one session, and it is marked.
  const rows = sessions(db, alice.email);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].mfaVerifiedAt);
});

test('wrong password during enrollment: no secret, nothing enrolled', async (t) => {
  const { auth, db, login, viewerOf, mfaLimiter, replayGuard } = await setup(t);
  const { browser } = await login(bob);
  const viewer = await viewerOf(browser);
  for (const password of ['wrong-password', '', 'x'.repeat(129), undefined]) {
    assert.deepEqual(await startEnrollment({ auth, viewer, headers: browser.headers(), password, limiter: mfaLimiter, replayGuard }), { ok: false, error: INCORRECT_PASSWORD });
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM twoFactor').get().n, 0);
  assert.equal((await viewerOf(browser)).mfa.enrolled, false);
});

test('enrollment only completes with a correct first code', async (t) => {
  const { auth, login, viewerOf, mfaLimiter, replayGuard } = await setup(t);
  const { browser } = await login(bob);
  const viewer = await viewerOf(browser);
  const started = await startEnrollment({ auth, viewer, headers: browser.headers(), password: bob.password, limiter: mfaLimiter, replayGuard });
  const secret = started.manualKey.replaceAll(' ', '');
  const right = totp(secret);
  const wrongCode = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
  for (const code of [wrongCode, '12345', 'abcdef', '']) {
    assert.deepEqual(await confirmEnrollment({ auth, viewer, headers: browser.headers(), code, limiter: mfaLimiter, replayGuard }), { ok: false, error: INVALID_CODE });
  }
  const after = await viewerOf(browser);
  assert.equal(after.mfa.enrolled, false, 'still not enrolled');
  assert.equal(after.mfa.verified, false);
  const done = await confirmEnrollment({ auth, viewer, headers: browser.headers(), code: right, limiter: mfaLimiter, replayGuard });
  assert.equal(done.ok, true);
});

test('an account with TOTP can never be re-enrolled from a password-only session', async (t) => {
  const { auth, db, login, viewerOf, mfaLimiter, replayGuard } = await setup(t);
  const old = await login(alice); // password-only session from before enrollment
  const viewerBefore = await viewerOf(old.browser);
  const started = await startEnrollment({ auth, viewer: viewerBefore, headers: old.browser.headers(), password: alice.password, limiter: mfaLimiter, replayGuard });
  const fresh = (await login(alice)).browser;
  await confirmEnrollment({ auth, viewer: await viewerOf(fresh), headers: fresh.headers(), code: totp(started.manualKey.replaceAll(' ', '')), limiter: mfaLimiter, replayGuard });

  const stale = await viewerOf(old.browser);
  assert.equal(stale.mfa.enrolled, true);
  assert.equal(stale.mfa.verified, false, 'the older password-only session never became verified');
  const secretBefore = db.prepare('SELECT secret FROM twoFactor').get().secret;
  assert.deepEqual(await startEnrollment({ auth, viewer: stale, headers: old.browser.headers(), password: alice.password, limiter: mfaLimiter, replayGuard }), { ok: false, error: ALREADY_ENROLLED });
  assert.equal(db.prepare('SELECT secret FROM twoFactor').get().secret, secretBefore, 'secret unchanged');
});

test('a new sign-in requires MFA again; only the challenge creates a verified session', async (t) => {
  const { db, login, viewerOf, enroll, challenge } = await setup(t);
  const { secret } = await enroll(alice);

  const { browser, twoFactor } = await login(alice);
  assert.equal(twoFactor, true, 'password alone gives a challenge');
  assert.equal(browser.has('better-auth.session_token'), false, 'no session cookie yet');
  assert.equal(await viewerOf(browser), null);

  const wrong = await challenge(alice, 'totp', '000000', browser);
  assert.deepEqual([wrong.ok, wrong.error], [false, INVALID_CODE]);
  const ok = await challenge(alice, 'totp', totp(secret, Date.now() + 30_000), browser);
  assert.equal(ok.ok, true, ok.error);
  assert.ok(!(ok.headers.getSetCookie().some((c) => c.startsWith('better-auth.trust_device'))), 'no trusted-device cookie');
  const v = await viewerOf(browser);
  assert.equal(v.mfa.verified, true);
  assert.ok(v.mfa.verifiedAt >= new Date(Date.now() - 10_000));

  // Each session's marker is its own: two sessions, both verified independently.
  assert.equal(sessions(db, alice.email).filter((s) => s.mfaVerifiedAt).length, 2);
});

test('logout and expiry remove the MFA-verified state', async (t) => {
  const { auth, db, viewerOf, enroll } = await setup(t);
  const { browser } = await enroll(alice);
  assert.equal((await viewerOf(browser)).mfa.verified, true);
  await auth.api.signOut({ headers: browser.headers() });
  assert.equal(await viewerOf(browser), null, 'revoked');

  const second = await enroll(bob);
  db.prepare('UPDATE session SET expiresAt = ? WHERE id IN (SELECT s.id FROM session s JOIN "user" u ON u.id = s.userId WHERE u.email = ?)')
    .run(new Date(Date.now() - 1000).toISOString(), bob.email);
  assert.equal(await viewerOf(second.browser), null, 'expired');
});

test('a client cannot set or extend mfaVerifiedAt', async (t) => {
  const { auth, db, login, viewerOf } = await setup(t);
  const { browser } = await login(bob);
  // Better Auth's session update API must not accept the field (input: false): whether it
  // rejects the request or ignores the value, the session stays unverified.
  assert.equal(typeof auth.api.updateSession, 'function');
  await auth.api.updateSession({ body: { mfaVerifiedAt: new Date().toISOString() }, headers: browser.headers() }).catch(() => {});
  assert.equal(db.prepare('SELECT mfaVerifiedAt FROM session').get().mfaVerifiedAt, null);
  assert.equal((await viewerOf(browser)).mfa.verified, false);
  // … and a session refresh never copies a marker forward.
  db.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() + 24 * 60 * 1000).toISOString());
  await resolveViewer({ auth, identityDb: db, headers: browser.headers(), refresh: true });
  assert.equal(db.prepare('SELECT mfaVerifiedAt FROM session').get().mfaVerifiedAt, null);
});

test('a marker from outside the session\'s lifetime is ignored', async (t) => {
  const { db, viewerOf, enroll } = await setup(t);
  const { browser } = await enroll(alice);
  assert.equal((await viewerOf(browser)).mfa.verified, true);
  db.prepare('UPDATE session SET mfaVerifiedAt = ?').run(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  assert.equal((await viewerOf(browser)).mfa.verified, false, 'older than the session');
  db.prepare('UPDATE session SET mfaVerifiedAt = ?').run(new Date(Date.now() + 3600 * 1000).toISOString());
  assert.equal((await viewerOf(browser)).mfa.verified, false, 'in the future');
});

test('backup codes work exactly once', async (t) => {
  const { viewerOf, enroll, challenge } = await setup(t);
  const { backupCodes } = await enroll(support);
  const first = await challenge(support, 'backup', backupCodes[0]);
  assert.equal(first.ok, true, first.error);
  assert.equal((await viewerOf(first.browser)).mfa.verified, true);

  const again = await challenge(support, 'backup', backupCodes[0]);
  assert.deepEqual([again.ok, again.error], [false, INVALID_BACKUP_CODE]);
  const other = await challenge(support, 'backup', backupCodes[1]);
  assert.equal(other.ok, true, 'a different unused code still works');
  for (const bad of ['', 'x', 'not a code!', 'a'.repeat(40)]) {
    assert.equal((await challenge(support, 'backup', bad)).error, INVALID_BACKUP_CODE);
  }
});

test('MFA attempts are rate limited per user, across new challenges', async (t) => {
  const { enroll, challenge } = await setup(t);
  const { secret } = await enroll(bob);
  for (let i = 0; i < 5; i++) {
    const r = await challenge(bob, 'totp', '000000'); // a new challenge each time
    assert.equal(r.ok, false);
  }
  const blocked = await challenge(bob, 'totp', totp(secret, Date.now() + 30_000));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rateLimited, true);
  assert.match(blocked.error, /^Too many attempts\. Try again in \d+ minute\(s\)\.$/);
});

test('Better Auth also invalidates a single challenge after 5 wrong codes', async (t) => {
  const { enroll, login, auth, ro, replayGuard } = await setup(t);
  const { secret } = await enroll(alice);
  const { browser } = await login(alice);
  const generous = createMfaRateLimiter(); // isolate Better Auth's own per-challenge limit
  generous.check = () => ({ allowed: true, retryAfterSeconds: 0 });
  let last;
  for (let i = 0; i < 6; i++) {
    last = await verifyChallenge({ auth, identityDb: ro, headers: browser.headers(), method: 'totp', code: '000000', limiter: generous, replayGuard });
  }
  assert.equal(last.restart, true);
  assert.ok([CHALLENGE_EXHAUSTED, CHALLENGE_EXPIRED].includes(last.error), last.error);
  const late = await verifyChallenge({ auth, identityDb: ro, headers: browser.headers(), method: 'totp', code: totp(secret, Date.now() + 30_000), limiter: generous, replayGuard });
  assert.equal(late.ok, false, 'even the right code cannot use an exhausted challenge');
});

test('a missing or forged challenge cookie is refused', async (t) => {
  const { auth, ro, mfaLimiter, replayGuard } = await setup(t);
  const none = await verifyChallenge({ auth, identityDb: ro, headers: new Headers(LOCAL), method: 'totp', code: '123456', limiter: mfaLimiter, replayGuard });
  assert.deepEqual([none.ok, none.error, none.restart], [false, CHALLENGE_EXPIRED, true]);
  const forged = await verifyChallenge({ auth, identityDb: ro, headers: new Headers({ ...LOCAL, cookie: 'better-auth.two_factor=2fa-forged.c2ln' }), method: 'totp', code: '123456', limiter: mfaLimiter, replayGuard });
  assert.deepEqual([forged.ok, forged.restart], [false, true]);
  assert.equal(challengeIdFrom(new Headers({ cookie: 'better-auth.two_factor=2fa-abc.sig%3D' })), '2fa-abc');
  assert.equal(challengeIdFrom(new Headers({ cookie: 'other=1' })), null);
});
