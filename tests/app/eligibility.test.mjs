import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccessDenied } from '../../lib/server/dal.js';
import { assertVerifiedCustomer, INELIGIBLE, readEligibility } from '../../lib/server/eligibility.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { authHarness } from '../helpers/auth-flow.mjs';

const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

function outcome(fn) {
  try {
    fn();
    return { reason: 'allowed' };
  } catch (err) {
    assert.ok(err instanceof AccessDenied, err.message);
    return { reason: err.reason, details: err.details };
  }
}

let kycSeq = 0;
const addKyc = (db, customerId, status) => {
  const at = Date.now() + 1000 + (kycSeq += 1); // strictly newer than earlier records
  db.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
    VALUES (?, ?, ?, 'test', ?, ?)`).run(`kyc_t${kycSeq}`, customerId, status, status === 'pending' ? null : at, at);
};

test('Alice and Bob are eligible to send money', async (t) => {
  const h = await authHarness(t);
  for (const [user, walletId] of [[alice, 'wal_demo_alice'], [bob, 'wal_demo_bob']]) {
    const { viewer } = await h.verifiedLogin(user);
    const { eligibility } = assertVerifiedCustomer(viewer, h.identityRo);
    assert.deepEqual({ ...eligibility, reasons: [...eligibility.reasons] }, { eligible: true, reasons: [], walletId, kycStatus: 'approved' });
  }
});

test('Carol is refused while KYC is pending; approval admits her on the next request; a later rejection blocks her again', async (t) => {
  const h = await authHarness(t);
  const { viewer } = await h.verifiedLogin(carol);
  assert.deepEqual(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)), { reason: 'not-eligible', details: [INELIGIBLE.kycPending] });

  addKyc(h.identityDb, 'cus_demo_carol', 'approved');
  assert.equal(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)).reason, 'allowed', 'approved KYC applies immediately');

  addKyc(h.identityDb, 'cus_demo_carol', 'rejected');
  assert.deepEqual(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)), { reason: 'not-eligible', details: [INELIGIBLE.kycRejected] });
});

test('frozen and closed wallets are refused', async (t) => {
  const h = await authHarness(t);
  const { viewer } = await h.verifiedLogin(bob);
  const setWallet = (status) => h.identityDb.prepare("UPDATE wallet SET status = ? WHERE wallet_id = 'wal_demo_bob'").run(status);

  setWallet('frozen');
  assert.deepEqual(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)), { reason: 'not-eligible', details: [INELIGIBLE.walletFrozen] });
  setWallet('active');
  assert.equal(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)).reason, 'allowed');
  setWallet('closed');
  assert.deepEqual(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)), { reason: 'not-eligible', details: [INELIGIBLE.walletClosed] });
});

test('a suspended customer is refused – also when the request started before the suspension', async (t) => {
  const h = await authHarness(t);
  const { browser, viewer } = await h.verifiedLogin(alice); // viewer snapshot: active
  h.identityDb.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run();
  // The re-check reads the database, not the snapshot (what Step 5 relies on).
  assert.deepEqual(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)), { reason: 'not-eligible', details: [INELIGIBLE.customerInactive] });
  // A freshly resolved viewer is refused earlier, at the role check.
  const fresh = await h.viewerOf(browser);
  assert.equal(outcome(() => assertVerifiedCustomer(fresh, h.identityRo)).reason, 'inactive');
});

test('no stale decision: an old viewer snapshot never outlives a database change', async (t) => {
  const h = await authHarness(t);
  const { viewer } = await h.verifiedLogin(carol);
  const decisions = [];
  const check = () => decisions.push(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)).reason);
  check();                                                   // pending
  addKyc(h.identityDb, 'cus_demo_carol', 'approved'); check(); // approved
  h.identityDb.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_carol'").run(); check();
  h.identityDb.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_carol'").run(); check();
  addKyc(h.identityDb, 'cus_demo_carol', 'pending'); check();  // a newer pending record wins
  assert.deepEqual(decisions, ['not-eligible', 'allowed', 'not-eligible', 'allowed', 'not-eligible']);
});

test('missing MFA and wrong roles are refused before eligibility is considered', async (t) => {
  const h = await authHarness(t);
  const { browser } = await h.passwordLogin(alice);
  const pwOnly = await h.viewerOf(browser);
  assert.equal(outcome(() => assertVerifiedCustomer(pwOnly, h.identityRo)).reason, 'mfa-required');
  const { viewer: ops } = await h.verifiedLogin(support);
  assert.equal(outcome(() => assertVerifiedCustomer(ops, h.identityRo)).reason, 'wrong-role');
  assert.equal(outcome(() => assertVerifiedCustomer(null, h.identityRo)).reason, 'no-session');
});

test('a customer without any wallet, or without KYC, is refused', async (t) => {
  const h = await authHarness(t);
  const stray = { email: 'nowallet@example.test', password: 'No-Wallet-Pass-1!' };
  await h.auth.api.signUpEmail({ body: { ...stray, name: 'No Wallet' } });
  const uid = h.identityRo.prepare('SELECT id FROM "user" WHERE email = ?').get(stray.email).id;
  h.identityDb.prepare("INSERT INTO customer (customer_id, auth_user_id, full_name, status, created_at) VALUES ('cus_nowallet', ?, 'No Wallet', 'active', ?)").run(uid, Date.now());
  const { viewer } = await h.verifiedLogin(stray);
  const e = readEligibility(h.identityRo, 'cus_nowallet');
  assert.deepEqual([...e.reasons], [INELIGIBLE.kycNotStarted, INELIGIBLE.noWallet]);
  assert.equal(outcome(() => assertVerifiedCustomer(viewer, h.identityRo)).reason, 'not-eligible');
});
