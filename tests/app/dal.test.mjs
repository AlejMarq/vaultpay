import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAuth } from '../../lib/server/auth.js';
import { AccessDenied, assertMfaVerified, landingPath, resolveViewer } from '../../lib/server/dal.js';
import { openIdentityDb } from '../../lib/server/db/index.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';
import { totp } from '../helpers/totp.mjs';

const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

async function setup(t) {
  const { dataDir } = await freshInstall(t);
  const { auth, db, close } = await createAuth({ dataDir });
  const ro = openIdentityDb({ dataDir, readonly: true });
  onCleanup(t, () => { ro.close(); close(); });
  const signIn = async (user) => {
    const res = await auth.api.signInEmail({ body: { email: user.email, password: user.password }, returnHeaders: true });
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
  };
  const viewer = (headers, opts) => resolveViewer({ auth, identityDb: ro, headers, ...opts });
  return { auth, db, ro, signIn, viewer };
}

const denial = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof AccessDenied); return err.reason; } return 'allowed'; };

test('no cookie, or a garbage cookie, resolves to no viewer', async (t) => {
  const { viewer } = await setup(t);
  assert.equal(await viewer(new Headers()), null);
  assert.equal(await viewer(new Headers({ cookie: 'better-auth.session_token=forged.value' })), null);
  assert.equal(landingPath(null), '/login');
});

test('customers resolve with customer record, wallet and current KYC', async (t) => {
  const { signIn, viewer } = await setup(t);
  const a = await viewer(await signIn(alice));
  assert.equal(a.kind, 'customer');
  assert.equal(a.email, alice.email);
  assert.deepEqual({ ...a.customer, wallet: { ...a.customer.wallet } }, {
    customerId: 'cus_demo_alice', fullName: 'Alice Demo', status: 'active', kycStatus: 'approved',
    wallet: { walletId: 'wal_demo_alice', status: 'active' },
  });
  assert.equal(a.ops, null);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.customer));

  const c = await viewer(await signIn(carol));
  assert.equal(c.customer.kycStatus, 'pending');
  assert.equal(c.customer.wallet.walletId, 'wal_demo_carol');
  assert.equal((await viewer(await signIn(bob))).customer.customerId, 'cus_demo_bob');
});

test('support resolves as a read-only ops user with no customer record', async (t) => {
  const { signIn, viewer } = await setup(t);
  const s = await viewer(await signIn(support));
  assert.equal(s.kind, 'ops');
  assert.deepEqual({ ...s.ops }, { opsUserId: 'ops_demo_support', fullName: 'Sam Support', role: 'support_readonly', status: 'active' });
  assert.equal(s.customer, null);
});

test('a login with neither a customer nor an ops record has no VaultPay role', async (t) => {
  const { auth, viewer } = await setup(t);
  await auth.api.signUpEmail({ body: { email: 'stray@example.test', password: 'Stray-Password-1!', name: 'Stray' } });
  const res = await auth.api.signInEmail({ body: { email: 'stray@example.test', password: 'Stray-Password-1!' }, returnHeaders: true });
  const v = await viewer(new Headers({ cookie: res.headers.getSetCookie()[0].split(';')[0] }));
  assert.equal(v.kind, 'none');
});

test('authorization data is read fresh on every request (no caching)', async (t) => {
  const { db, signIn, viewer } = await setup(t);
  const headers = await signIn(carol);
  assert.equal((await viewer(headers)).customer.kycStatus, 'pending');
  db.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
    VALUES ('kyc_carol_ok', 'cus_demo_carol', 'approved', 'manual', ?, ?)`).run(Date.now() + 1, Date.now() + 1);
  assert.equal((await viewer(headers)).customer.kycStatus, 'approved');
  db.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_carol'").run();
  assert.equal((await viewer(headers)).customer.wallet.status, 'frozen');
});

test('password-only sessions are denied protected access (MFA required)', async (t) => {
  const { signIn, viewer } = await setup(t);
  for (const user of [alice, bob, carol, support]) {
    const v = await viewer(await signIn(user));
    assert.equal(v.mfa.verified, false);
    assert.equal(denial(() => assertMfaVerified(v)), 'mfa-required', user.email);
    assert.equal(landingPath(v), '/mfa');
  }
  assert.equal(denial(() => assertMfaVerified(null)), 'no-session');
});

test('twoFactorEnabled alone is not treated as a completed MFA login', async (t) => {
  const { auth, signIn, viewer } = await setup(t);
  const older = await signIn(alice); // password-only session, still open elsewhere
  const headers = await signIn(alice);
  const { totpURI } = await auth.api.enableTwoFactor({ body: { password: alice.password }, headers });
  const res = await auth.api.verifyTOTP({ body: { code: totp(new URL(totpURI).searchParams.get('secret')) }, headers, returnHeaders: true });
  const enrolled = new Headers({ cookie: res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token=')).split(';')[0] });

  const stale = await viewer(older);
  assert.equal(stale.mfa.enrolled, true, 'TOTP is enrolled on the account');
  assert.equal(stale.mfa.verified, false, 'but this session never completed MFA');
  assert.equal(denial(() => assertMfaVerified(stale)), 'mfa-required');
  assert.equal((await viewer(enrolled)).mfa.verified, true, 'only the session that verified the code is marked');
});

test('the MFA check only accepts a real mfaVerifiedAt timestamp on the session', () => {
  const base = { mfa: { verified: false } };
  assert.equal(denial(() => assertMfaVerified(base)), 'mfa-required');
  assert.equal(denial(() => assertMfaVerified({ mfa: { verified: true } })), 'allowed');
});

test('expired sessions resolve to no viewer and are removed', async (t) => {
  const { db, signIn, viewer } = await setup(t);
  const headers = await signIn(alice);
  assert.ok(await viewer(headers));
  db.prepare('UPDATE session SET expiresAt = ?').run(Date.now() - 1000);
  assert.equal(await viewer(headers), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, 0);
});

test('signing out revokes the session immediately', async (t) => {
  const { auth, signIn, viewer } = await setup(t);
  const headers = await signIn(bob);
  await auth.api.signOut({ headers });
  assert.equal(await viewer(headers), null);
});

test('page reads never extend the session; refresh only when asked (Server Actions)', async (t) => {
  const { db, signIn, viewer } = await setup(t);
  const headers = await signIn(alice);
  // Pretend the session was last refreshed 6 minutes ago (beyond the 5-minute update age).
  // Better Auth stores expiresAt as ISO-8601 text.
  const aged = new Date(Date.now() + 24 * 60 * 1000).toISOString();
  const stored = () => db.prepare('SELECT expiresAt FROM session').get().expiresAt;
  db.prepare('UPDATE session SET expiresAt = ?').run(aged);
  await viewer(headers);
  assert.equal(stored(), aged, 'read-only resolution leaves expiry alone');
  await viewer(headers, { refresh: true });
  const extended = Date.parse(stored()) - Date.now();
  assert.ok(extended > 29 * 60 * 1000 && extended <= 30 * 60 * 1000, `refresh extends to a full 30 minutes (got ${extended} ms)`);
});
