import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { INVALID_CODE } from '../../lib/server/mfa.js';
import { createTotpReplayGuard, TOTP_CLAIM_RETENTION_MS } from '../../lib/server/totp-replay.js';
import { DEMO_CUSTOMERS } from '../../scripts/setup/demo-data.mjs';
import { authHarness } from '../helpers/auth-flow.mjs';
import { totp } from '../helpers/totp.mjs';

const [alice, bob] = DEMO_CUSTOMERS;

test('Better Auth alone would accept one code for two challenges – VaultPay refuses the second', async (t) => {
  const h = await authHarness(t);
  const { secret } = await h.verifiedLogin(alice);
  const code = totp(secret, Date.now() + 30_000); // a code not used by enrollment

  const first = await h.challenge(alice, code);
  assert.equal(first.ok, true, first.error);
  const second = await h.challenge(alice, code);
  assert.deepEqual([second.ok, second.error], [false, INVALID_CODE], 'replay across a new challenge');
  assert.equal(await h.viewerOf(second.browser), null, 'no session from the replayed code');
  const third = await h.challenge(alice, code);
  assert.equal(third.ok, false);
});

test('the enrollment code cannot be reused for the next sign-in', async (t) => {
  const h = await authHarness(t);
  const { enrollmentCode } = await h.verifiedLogin(bob);
  const reuse = await h.challenge(bob, enrollmentCode);
  assert.deepEqual([reuse.ok, reuse.error], [false, INVALID_CODE]);
});

test('concurrent attempts with one code: exactly one succeeds', async (t) => {
  const h = await authHarness(t);
  const { secret } = await h.verifiedLogin(alice);
  const code = totp(secret, Date.now() + 30_000);
  // Two separate challenges, both submitting the same valid code at once.
  const [a, b] = await Promise.all([
    h.passwordLogin(alice), h.passwordLogin(alice),
  ]);
  const { verifyChallenge } = await import('../../lib/server/mfa.js');
  const attempt = (browser) => verifyChallenge({ auth: h.auth, identityDb: h.identityRo, headers: browser.headers(), method: 'totp', code, limiter: h.limiters.mfa, replayGuard: h.replayGuard });
  const results = await Promise.all([attempt(a.browser), attempt(b.browser)]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok)));
});

test('a code another user used is still accepted for this user', async (t) => {
  const h = await authHarness(t);
  const { secret } = await h.verifiedLogin(alice);
  // Claims are per user: a claim on the same digits for Bob does not block Alice.
  const code = totp(secret, Date.now() + 30_000);
  const bobId = h.identityRo.prepare('SELECT id FROM "user" WHERE email = ?').get(bob.email).id;
  assert.ok(h.replayGuard.claim(bobId, code));
  assert.equal((await h.challenge(alice, code)).ok, true);
});

test('claims: atomic, released on rejection, expire after the window, store only a hash', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'u1\');');
  db.exec(`CREATE TABLE totp_code_use (user_id TEXT NOT NULL REFERENCES "user"(id), code_hash TEXT NOT NULL,
    claimed_at INTEGER NOT NULL, claim_token TEXT, PRIMARY KEY (user_id, code_hash)) STRICT, WITHOUT ROWID;`);
  let now = 1_000_000;
  const guard = createTotpReplayGuard(db, { now: () => now });

  const first = guard.claim('u1', '123456');
  assert.ok(first);
  assert.equal(guard.claim('u1', '123456'), null, 'second claim refused');
  first.release(); // e.g. Better Auth rejected the code
  assert.ok(guard.claim('u1', '123456'), 'a released claim can be made again');

  const row = db.prepare('SELECT code_hash FROM totp_code_use').get();
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!row.code_hash.includes('123456'));

  now += TOTP_CLAIM_RETENTION_MS + 1;
  assert.ok(guard.claim('u1', '123456'), 'claims expire after the retention window');
  assert.equal(db.prepare('SELECT count(*) AS n FROM totp_code_use').get().n, 1, 'expired claims are purged');
});

test('regression: a failed attempt\'s release cannot remove another request\'s successful claim', async (t) => {
  const h = await authHarness(t);
  const userId = h.identityRo.prepare('SELECT id FROM "user" WHERE email = ?').get(alice.email).id;
  // Two "processes" (separate guards on the same database) with a frozen clock, so both
  // claims carry the same claimed_at – the case a timestamp-only release got wrong.
  const fixed = () => 1_800_000_000_000;
  const failing = createTotpReplayGuard(h.identityDb, { now: fixed });
  const succeeding = createTotpReplayGuard(h.identityDb, { now: fixed });

  const a = failing.claim(userId, '424242');
  a.release(); // A: Better Auth rejected the code
  const b = succeeding.claim(userId, '424242'); // B: claims the same code, same millisecond, and succeeds
  assert.ok(b);
  a.release(); // A's release runs again late (retry / duplicate call)
  assert.equal(succeeding.claim(userId, '424242'), null, 'B\'s claim is still in place – the code stays used');
  assert.equal(h.identityDb.prepare('SELECT count(*) AS n FROM totp_code_use WHERE user_id = ?').get(userId).n, 1);
});

test('claims cannot be edited in the real schema', async (t) => {
  const h = await authHarness(t);
  const { secret } = await h.verifiedLogin(alice);
  await h.challenge(alice, totp(secret, Date.now() + 30_000));
  assert.throws(() => h.identityDb.prepare('UPDATE totp_code_use SET claimed_at = 1').run(), /cannot be changed/);
});
