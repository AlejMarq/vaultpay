import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccessDenied, assertCustomer, assertSupport, deniedPath, landingPath } from '../../lib/server/dal.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { authHarness } from '../helpers/auth-flow.mjs';

const [alice, , carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

const reason = (fn) => {
  try {
    fn();
    return 'allowed';
  } catch (err) {
    assert.ok(err instanceof AccessDenied, err.message);
    return err.reason;
  }
};

test('MFA-verified customers pass requireCustomer, never requireSupport', async (t) => {
  const h = await authHarness(t);
  for (const user of [alice, carol]) { // Carol: KYC pending – may still view her wallet
    const { viewer } = await h.verifiedLogin(user);
    assert.equal(reason(() => assertCustomer(viewer)), 'allowed', user.email);
    assert.equal(reason(() => assertSupport(viewer)), 'wrong-role', user.email);
    assert.equal(landingPath(viewer), '/wallet');
  }
});

test('the MFA-verified support user passes requireSupport, never requireCustomer', async (t) => {
  const h = await authHarness(t);
  const { viewer } = await h.verifiedLogin(support);
  assert.equal(reason(() => assertSupport(viewer)), 'allowed');
  assert.equal(reason(() => assertCustomer(viewer)), 'wrong-role');
  assert.equal(landingPath(viewer), '/support');
});

test('password-only sessions pass neither guard', async (t) => {
  const h = await authHarness(t);
  for (const user of [alice, support]) {
    const { browser } = await h.passwordLogin(user);
    const viewer = await h.viewerOf(browser);
    assert.equal(reason(() => assertCustomer(viewer)), 'mfa-required');
    assert.equal(reason(() => assertSupport(viewer)), 'mfa-required');
    assert.equal(landingPath(viewer), '/mfa');
  }
  assert.equal(reason(() => assertCustomer(null)), 'no-session');
  assert.equal(reason(() => assertSupport(null)), 'no-session');
});

test('suspended and closed customers are refused – on the very next request', async (t) => {
  const h = await authHarness(t);
  const { browser } = await h.verifiedLogin(alice);
  const write = (status) => h.identityDb.prepare("UPDATE customer SET status = ? WHERE customer_id = 'cus_demo_alice'").run(status);

  write('suspended');
  const suspended = await h.viewerOf(browser);
  assert.equal(reason(() => assertCustomer(suspended)), 'inactive');
  assert.equal(landingPath(suspended), '/access-denied');

  write('active');
  const reactivated = await h.viewerOf(browser);
  assert.equal(reason(() => assertCustomer(reactivated)), 'allowed');

  write('closed');
  const closed = await h.viewerOf(browser);
  assert.equal(reason(() => assertCustomer(closed)), 'inactive');
});

test('a disabled ops user is refused', async (t) => {
  const h = await authHarness(t);
  const { browser } = await h.verifiedLogin(support);
  h.identityDb.prepare("UPDATE ops_user SET status = 'disabled' WHERE ops_user_id = 'ops_demo_support'").run();
  const viewer = await h.viewerOf(browser);
  assert.equal(reason(() => assertSupport(viewer)), 'inactive');
  assert.equal(landingPath(viewer), '/access-denied');
});

test('an account with no VaultPay role is refused everywhere, even after MFA', async (t) => {
  const h = await authHarness(t);
  const stray = { email: 'stray@example.test', password: 'Stray-Password-1!' };
  await h.auth.api.signUpEmail({ body: { ...stray, name: 'Stray' } });
  const { viewer } = await h.verifiedLogin(stray);
  assert.equal(viewer.kind, 'none');
  assert.equal(viewer.mfa.verified, true);
  assert.equal(reason(() => assertCustomer(viewer)), 'wrong-role');
  assert.equal(reason(() => assertSupport(viewer)), 'wrong-role');
  assert.equal(landingPath(viewer), '/access-denied');
});

test('refusals map to login, MFA or access denied', () => {
  assert.equal(deniedPath(new AccessDenied('no-session')), '/login');
  assert.equal(deniedPath(new AccessDenied('mfa-required')), '/mfa');
  assert.equal(deniedPath(new AccessDenied('wrong-role')), '/access-denied');
  assert.equal(deniedPath(new AccessDenied('inactive')), '/access-denied');
});
