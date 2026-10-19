import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createAuditWriter, SUPPORT_EVENTS } from '../../lib/server/audit.js';
import { AccessDenied } from '../../lib/server/dal.js';
import * as supportModule from '../../lib/server/support.js';
import { lookupCustomer, maskEmail, maskPhone } from '../../lib/server/support.js';
import { getWalletOverview } from '../../lib/server/wallet.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { authHarness } from '../helpers/auth-flow.mjs';

const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;
const T = Date.now() - 60_000;

// Transfers: alice→bob, bob→alice, carol→bob, carol→Demo Coffee.
function seedTransfers(db) {
  const ins = db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, idempotency_key, status, pending_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending_risk', ?, ?, ?)`);
  const rows = [
    ['trf_a_to_b', 'wal_demo_alice', 'wallet', 'wal_demo_bob', 1250, T + 1],
    ['trf_b_to_a', 'wal_demo_bob', 'wallet', 'wal_demo_alice', 500, T + 2],
    ['trf_c_to_b', 'wal_demo_carol', 'wallet', 'wal_demo_bob', 700, T + 3],
    ['trf_c_to_m', 'wal_demo_carol', 'merchant', 'mer_demo_coffee', 300, T + 4],
  ];
  for (const [id, from, type, to, amount, at] of rows) ins.run(id, from, type, to, amount, `idem-${id}`, at + 600_000, at, at);
}

const ids = (transfers) => transfers.map((t) => t.transferId);
const denied = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AccessDenied, err.message);
    return err.reason;
  }
  return 'allowed';
};

// ---------------------------------------------------------------------------
// Customer wallet: own data only
// ---------------------------------------------------------------------------
test('each customer sees only their own wallet and transfers', async (t) => {
  const h = await authHarness(t);
  seedTransfers(h.transactionRw);
  const dbs = { identityDb: h.identityRo, transactionDb: h.transactionRo };

  const a = getWalletOverview((await h.verifiedLogin(alice)).viewer, dbs);
  assert.equal(a.wallet.walletId, 'wal_demo_alice');
  assert.equal(a.kycStatus, 'approved');
  assert.deepEqual(ids(a.transfers), ['trf_b_to_a', 'trf_a_to_b']);
  assert.deepEqual(a.transfers.map((x) => x.direction), ['received', 'sent']);

  const b = getWalletOverview((await h.verifiedLogin(bob)).viewer, dbs);
  assert.deepEqual(ids(b.transfers), ['trf_c_to_b', 'trf_b_to_a', 'trf_a_to_b']);

  const c = getWalletOverview((await h.verifiedLogin(carol)).viewer, dbs);
  assert.equal(c.kycStatus, 'pending');
  assert.deepEqual(ids(c.transfers), ['trf_c_to_m', 'trf_c_to_b']);
  assert.equal(c.transfers[0].counterparty.label, 'Demo Coffee');

  assert.ok(!('balance' in a) && !('balanceCents' in a), 'no balance: Core Banking is reached only via CBI');
});

test('the wallet overview refuses support users and password-only sessions', async (t) => {
  const h = await authHarness(t);
  const dbs = { identityDb: h.identityRo, transactionDb: h.transactionRo };
  assert.equal(denied(() => getWalletOverview(null, dbs)), 'no-session');
  const { viewer: s } = await h.verifiedLogin(support);
  assert.equal(denied(() => getWalletOverview(s, dbs)), 'wrong-role');
  const { browser } = await h.passwordLogin(bob);
  const pwOnly = await h.viewerOf(browser);
  assert.equal(denied(() => getWalletOverview(pwOnly, dbs)), 'mfa-required');
});

test('Next.js code never opens the mock Core Banking database', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|mjs)$/.test(e.name) && /openMockCoreBankingDb|['"]mock-core-banking['"]/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  scan('app');
  for (const f of ['auth.js', 'dal.js', 'session.js', 'wallet.js', 'support.js', 'transfers.js', 'audit.js', 'health.js', 'mfa.js', 'login.js']) {
    if (/openMockCoreBankingDb|['"]mock-core-banking['"]/.test(fs.readFileSync(path.join('lib', 'server', f), 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Support lookup: read-only, masked, audited
// ---------------------------------------------------------------------------
function supportSetup(h) {
  const audit = createAuditWriter(h.transactionRw);
  const deps = { identityDb: h.identityRo, transactionDb: h.transactionRo, audit };
  const events = () => h.transactionRo.prepare('SELECT actor_type, actor_id, event_type, subject_wallet_id FROM audit_event ORDER BY occurred_at, rowid').all();
  return { deps, events };
}

test('support finds a customer by email with masked contact details and read-only history', async (t) => {
  const h = await authHarness(t);
  seedTransfers(h.transactionRw);
  const { deps } = supportSetup(h);
  const { viewer } = await h.verifiedLogin(support);

  const r = lookupCustomer(viewer, '  Alice@Example.TEST ', deps);
  assert.equal(r.found, true);
  assert.deepEqual({ ...r.customer }, {
    customerId: 'cus_demo_alice', fullName: 'Alice Demo', maskedEmail: 'a***e@example.test', maskedPhone: '+•-•••-••01', status: 'active', kycStatus: 'approved',
  });
  assert.deepEqual({ ...r.wallet }, { walletId: 'wal_demo_alice', status: 'active' });
  assert.deepEqual(ids(r.transfers), ['trf_b_to_a', 'trf_a_to_b']);
  assert.ok(!JSON.stringify(r).includes('alice@example.test'), 'full email never returned');
  assert.ok(!JSON.stringify(r).includes('555-0101'), 'full phone never returned');

  assert.equal(lookupCustomer(viewer, carol.email, deps).customer.kycStatus, 'pending');
});

test('only customers can be found: unknown, malformed and ops emails all say "not found"', async (t) => {
  const h = await authHarness(t);
  const { deps } = supportSetup(h);
  const { viewer } = await h.verifiedLogin(support);
  for (const email of ['nobody@example.test', 'support@example.test', 'not-an-email', '', undefined]) {
    assert.deepEqual({ ...lookupCustomer(viewer, email, deps) }, { found: false }, String(email));
  }
});

test('every search and view is audited, before data is returned', async (t) => {
  const h = await authHarness(t);
  const { deps, events } = supportSetup(h);
  const { viewer } = await h.verifiedLogin(support);
  lookupCustomer(viewer, alice.email, deps);
  lookupCustomer(viewer, 'nobody@example.test', deps);
  assert.deepEqual(events(), [
    { actor_type: 'ops_user', actor_id: 'ops_demo_support', event_type: SUPPORT_EVENTS.search, subject_wallet_id: null },
    { actor_type: 'ops_user', actor_id: 'ops_demo_support', event_type: SUPPORT_EVENTS.view, subject_wallet_id: 'wal_demo_alice' },
    { actor_type: 'ops_user', actor_id: 'ops_demo_support', event_type: SUPPORT_EVENTS.search, subject_wallet_id: null },
  ]);

  // Fail closed: if the audit record cannot be written, no customer data is returned.
  const broken = { ...deps, audit: { recordSupportAccess() { throw new Error('audit unavailable'); } } };
  assert.throws(() => lookupCustomer(viewer, alice.email, broken), /audit unavailable/);
});

test('the audit writer only appends registered support events', async (t) => {
  const h = await authHarness(t);
  const audit = createAuditWriter(h.transactionRw);
  assert.match(audit.recordSupportAccess({ opsUserId: 'ops_demo_support', eventType: SUPPORT_EVENTS.search }), /^aud_[0-9a-f]{24}$/);
  assert.throws(() => audit.recordSupportAccess({ opsUserId: 'ops_demo_support', eventType: 'transfer.created' }), /not a support audit event/);
  assert.throws(() => audit.recordSupportAccess({ opsUserId: "x'; DROP", eventType: SUPPORT_EVENTS.search }), /invalid ops user id/);
  assert.deepEqual(Object.keys(audit), ['recordSupportAccess'], 'no other operations exposed');
  assert.throws(() => h.transactionRw.prepare('DELETE FROM audit_event').run(), /append-only/);
  assert.throws(() => h.transactionRw.prepare("UPDATE audit_event SET actor_id = 'ops_other'").run(), /append-only/);
});

test('support cannot use the lookup without the right role and MFA', async (t) => {
  const h = await authHarness(t);
  const { deps, events } = supportSetup(h);
  const { viewer: customer } = await h.verifiedLogin(alice);
  assert.equal(denied(() => lookupCustomer(customer, bob.email, deps)), 'wrong-role');
  const { browser } = await h.passwordLogin(support);
  const pwOnly = await h.viewerOf(browser);
  assert.equal(denied(() => lookupCustomer(pwOnly, bob.email, deps)), 'mfa-required');
  assert.deepEqual(events(), [], 'refused lookups leave no audit record and return nothing');
});

test('support has no write path: its connections are read-only and the module only reads', async (t) => {
  const h = await authHarness(t);
  for (const [db, sql] of [
    [h.identityRo, "UPDATE customer SET status = 'closed'"],
    [h.identityRo, "UPDATE wallet SET status = 'frozen'"],
    [h.identityRo, "INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at) VALUES ('kyc_x', 'cus_demo_carol', 'approved', 'x', 1, 1)"],
    [h.transactionRo, "UPDATE transfer SET status = 'declined'"],
    [h.transactionRo, "INSERT INTO audit_event (event_id, actor_type, actor_id, event_type, occurred_at) VALUES ('aud_x', 'ops_user', 'ops_demo_support', 'support.customer_search', 1)"],
  ]) {
    assert.throws(() => db.prepare(sql).run(), { code: 'SQLITE_READONLY' }, sql);
  }
  assert.deepEqual(Object.keys(supportModule).sort(), ['lookupCustomer', 'maskEmail', 'maskPhone']);
});

test('masking keeps only what support needs', () => {
  assert.equal(maskEmail('alice@example.test'), 'a***e@example.test');
  assert.equal(maskEmail('b@example.test'), 'b***@example.test');
  assert.equal(maskPhone('+1-555-0103'), '+•-•••-••03');
  assert.equal(maskPhone(null), null);
});
