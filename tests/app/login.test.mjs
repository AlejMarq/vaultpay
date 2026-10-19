import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAuth } from '../../lib/server/auth.js';
import { attemptLogin, GENERIC_LOGIN_ERROR } from '../../lib/server/login.js';
import { createLoginRateLimiter } from '../../lib/server/rate-limit.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';

const LOCAL = () => new Headers({ 'x-forwarded-for': '127.0.0.1' });
const [alice, bob] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

async function setup(t) {
  const { dataDir } = await freshInstall(t);
  const { auth, db, close } = await createAuth({ dataDir });
  onCleanup(t, close);
  const limiter = createLoginRateLimiter();
  const login = (email, password, headers = LOCAL()) => attemptLogin({ auth, limiter, headers, email, password });
  return { auth, db, limiter, login };
}

const sessionCookie = (headers) => headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));

test('correct credentials log in every demo account and issue a session cookie', async (t) => {
  const { db, login } = await setup(t);
  for (const user of [alice, bob, support]) {
    const result = await login(user.email, user.password);
    assert.equal(result.ok, true, user.email);
    assert.equal(result.twoFactor, false);
    const cookie = sessionCookie(result.headers);
    assert.ok(cookie, `${user.email} gets a session cookie`);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=1800']) assert.ok(cookie.includes(attr), `${attr} in ${cookie}`);
    assert.doesNotMatch(cookie, /Domain=/i, 'host-only cookie');
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, 3);
});

test('emails are matched case-insensitively', async (t) => {
  const { login } = await setup(t);
  assert.equal((await login('  ALICE@Example.Test ', alice.password)).ok, true);
});

test('wrong password, unknown email and malformed input all get the same generic error', async (t) => {
  const { db, login } = await setup(t);
  const results = [
    await login(alice.email, 'wrong-password'),
    await login('nobody@example.test', alice.password),
    await login('not-an-email', 'x'),
    await login(alice.email, ''),
    await login(alice.email, 'x'.repeat(129)),
    await login(undefined, undefined),
  ];
  for (const r of results) assert.deepEqual(r, { ok: false, error: GENERIC_LOGIN_ERROR });
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, 0, 'no session for any failure');
});

test('the rate limiter blocks further attempts – even with the right password', async (t) => {
  const { db, login } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await login(bob.email, `wrong-${i}`)).error, GENERIC_LOGIN_ERROR);
  const blocked = await login(bob.email, bob.password);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rateLimited, true);
  assert.match(blocked.error, /^Too many sign-in attempts\. Try again in \d+ minute\(s\)\.$/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, 0);
  // the limit is per account: Alice is unaffected
  assert.equal((await login(alice.email, alice.password)).ok, true);
});

test('a spoofed X-Forwarded-For does not give a fresh rate-limit bucket', async (t) => {
  const { login } = await setup(t);
  for (let i = 0; i < 10; i++) {
    await login(bob.email, `wrong-${i}`, new Headers({ 'x-forwarded-for': `203.0.113.${i}` }));
  }
  const r = await login(bob.email, bob.password, new Headers({ 'x-forwarded-for': '198.51.100.7' }));
  assert.equal(r.rateLimited, true);
});

test('an account with TOTP enrolled gets a challenge, not a session, from its password', async (t) => {
  const { auth, db, login } = await setup(t);
  const first = await login(alice.email, alice.password);
  const headers = new Headers({ cookie: sessionCookie(first.headers).split(';')[0] });
  const { totpURI } = await auth.api.enableTwoFactor({ body: { password: alice.password }, headers });
  assert.ok(totpURI);
  const { totp } = await import('../helpers/totp.mjs');
  await auth.api.verifyTOTP({ body: { code: totp(new URL(totpURI).searchParams.get('secret')) }, headers });
  const before = db.prepare('SELECT count(*) AS n FROM session').get().n;

  const result = await login(alice.email, alice.password);
  assert.equal(result.ok, true);
  assert.equal(result.twoFactor, true);
  assert.equal(sessionCookie(result.headers)?.includes('Max-Age=0') ?? true, true, 'no live session cookie');
  assert.ok(result.headers.getSetCookie().some((c) => c.startsWith('better-auth.two_factor=')), 'challenge cookie');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, before, 'password alone created no session');
});
