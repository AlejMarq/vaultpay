import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { betterAuth } from 'better-auth';

import { buildAuthOptions } from '../../lib/server/auth-config.js';
import { createDatabase, openIdentityDb, openMockCoreBankingDb } from '../../lib/server/db/index.js';
import { runChecks } from '../../scripts/setup/check.mjs';
import { DEMO_CUSTOMERS, DEMO_MERCHANTS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { onCleanup, tempDataDir } from '../helpers/db.mjs';
import { freshInstall, readEnv, snapshot } from '../helpers/setup.mjs';

const ALL_LOGINS = [...DEMO_CUSTOMERS, ...DEMO_OPS_USERS];

function open(t, dataDir) {
  const identity = openIdentityDb({ dataDir });
  const bank = openMockCoreBankingDb({ dataDir });
  onCleanup(t, () => { identity.close(); bank.close(); });
  return { identity, bank };
}

function authFor(identity, dataDir) {
  const secret = util.parseEnv(readEnv(dataDir, 'web')).BETTER_AUTH_SECRET;
  return betterAuth(buildAuthOptions({ database: identity, secret, baseURL: 'http://localhost:3000' }));
}

const counts = (identity, bank) => ({
  users: identity.prepare('SELECT count(*) AS n FROM "user"').get().n,
  accounts: identity.prepare('SELECT count(*) AS n FROM account').get().n,
  customers: identity.prepare('SELECT count(*) AS n FROM customer').get().n,
  kyc: identity.prepare('SELECT count(*) AS n FROM kyc_verification').get().n,
  wallets: identity.prepare('SELECT count(*) AS n FROM wallet').get().n,
  ops: identity.prepare('SELECT count(*) AS n FROM ops_user').get().n,
  merchants: identity.prepare('SELECT count(*) AS n FROM merchant').get().n,
  bankAccounts: bank.prepare('SELECT count(*) AS n FROM account').get().n,
  sessions: identity.prepare('SELECT count(*) AS n FROM session').get().n,
});

const balance = (bank, ref) => bank.prepare('SELECT balance_cents FROM account WHERE account_ref = ?').get(ref).balance_cents;

// ---------------------------------------------------------------------------
test('demo users sign in with their documented passwords; wrong passwords fail', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  const auth = authFor(identity, dataDir);
  for (const u of ALL_LOGINS) {
    const res = await auth.api.signInEmail({ body: { email: u.email, password: u.password } });
    assert.ok(res.token, `${u.email} signs in`);
    assert.equal(res.user.email, u.email);
    assert.equal(res.user.twoFactorEnabled, false, `${u.email} enrolls TOTP on first sign-in (Step 3)`);
    await assert.rejects(auth.api.signInEmail({ body: { email: u.email, password: `${u.password}x` } }), `${u.email} wrong password`);
  }
});

test('passwords are stored only as Better Auth hashes', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  const rows = identity.prepare(`SELECT u.email, a.password, a.providerId FROM account a JOIN "user" u ON u.id = a.userId`).all();
  assert.equal(rows.length, ALL_LOGINS.length);
  for (const u of ALL_LOGINS) {
    const row = rows.find((r) => r.email === u.email);
    assert.equal(row.providerId, 'credential');
    assert.notEqual(row.password, u.password);
    assert.ok(!row.password.includes(u.password));
    assert.match(row.password, /^[0-9a-f]+:[0-9a-f]+$/, 'salt:hash format');
  }
  const file = fs.readFileSync(path.join(dataDir, 'db', 'identity.db'));
  for (const u of ALL_LOGINS) assert.ok(!file.includes(Buffer.from(u.password)), `${u.email} plaintext not in database file`);
});

test('seeding creates no sessions', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity, bank } = open(t, dataDir);
  assert.equal(counts(identity, bank).sessions, 0);
});

test('KYC: Alice and Bob approved, Carol pending; support has no customer record', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  const kyc = Object.fromEntries(identity.prepare(`SELECT u.email, k.status, k.verified_at FROM customer_current_kyc k
    JOIN customer c ON c.customer_id = k.customer_id JOIN "user" u ON u.id = c.auth_user_id`).all().map((r) => [r.email, r]));
  assert.equal(kyc['alice@example.test'].status, 'approved');
  assert.equal(kyc['bob@example.test'].status, 'approved');
  assert.equal(kyc['carol@example.test'].status, 'pending');
  assert.equal(kyc['carol@example.test'].verified_at, null);
  assert.equal(kyc['support@example.test'], undefined);
});

test('wallets: each customer owns exactly their own wallet, mapped to their bank account', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  const rows = identity.prepare(`SELECT u.email, w.wallet_id, w.core_account_ref, w.status, w.currency FROM wallet w
    JOIN customer c ON c.customer_id = w.customer_id JOIN "user" u ON u.id = c.auth_user_id ORDER BY u.email`).all();
  assert.deepEqual(rows, DEMO_CUSTOMERS.map((c) => ({ email: c.email, wallet_id: c.walletId, core_account_ref: c.coreAccountRef, status: 'active', currency: 'USD' })));
});

test('support is a read-only ops user and not a customer', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  const ops = identity.prepare(`SELECT u.email, o.role, o.status FROM ops_user o JOIN "user" u ON u.id = o.auth_user_id`).all();
  assert.deepEqual(ops, [{ email: 'support@example.test', role: 'support_readonly', status: 'active' }]);
});

test('Demo Coffee merchant exists with its QR identifier and bank account', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity, bank } = open(t, dataDir);
  const m = identity.prepare('SELECT * FROM merchant').all();
  assert.equal(m.length, 1);
  assert.equal(m[0].display_name, 'Demo Coffee');
  assert.equal(m[0].qr_identifier, 'vaultpay:merchant:demo-coffee');
  assert.equal(m[0].status, 'active');
  assert.equal(bank.prepare('SELECT holder_type FROM account WHERE account_ref = ?').get(m[0].core_account_ref).holder_type, 'merchant');
});

test('mock Core Banking holds the documented opening balances', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { bank } = open(t, dataDir);
  const accounts = bank.prepare('SELECT account_ref, holder_type, balance_cents, opening_balance_cents FROM account ORDER BY account_ref').all();
  assert.deepEqual(accounts, [
    { account_ref: 'MCB-1001', holder_type: 'customer', balance_cents: 50_000, opening_balance_cents: 50_000 }, // Alice $500.00
    { account_ref: 'MCB-1002', holder_type: 'customer', balance_cents: 25_000, opening_balance_cents: 25_000 }, // Bob $250.00
    { account_ref: 'MCB-1003', holder_type: 'customer', balance_cents: 10_000, opening_balance_cents: 10_000 }, // Carol $100.00
    { account_ref: 'MCB-2001', holder_type: 'merchant', balance_cents: 0, opening_balance_cents: 0 },          // Demo Coffee $0.00
  ]);
  assert.equal(bank.prepare('SELECT count(*) AS n FROM posting').get().n, 0);
});

test('mock bank refuses negative balances and keeps postings append-only', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { bank } = open(t, dataDir);
  assert.throws(() => bank.prepare("UPDATE account SET balance_cents = -1 WHERE account_ref = 'MCB-1001'").run(), /CHECK/);
  assert.throws(() => bank.prepare("UPDATE account SET opening_balance_cents = 1 WHERE account_ref = 'MCB-1001'").run(), /cannot change/);
  assert.throws(() => bank.prepare('DELETE FROM account').run(), /not deleted/);
  bank.prepare("INSERT INTO posting VALUES ('p1', 'idem-0001', 'MCB-1001', 'MCB-1002', 100, 1)").run();
  assert.throws(() => bank.prepare("INSERT INTO posting VALUES ('p2', 'idem-0001', 'MCB-1001', 'MCB-1002', 100, 1)").run(), /UNIQUE/);
  assert.throws(() => bank.prepare('UPDATE posting SET amount_cents = 1').run(), /append-only/);
});

// ---------------------------------------------------------------------------
// Repeat-run safety
// ---------------------------------------------------------------------------
test('running setup again duplicates nothing and changes no file', async (t) => {
  const { dataDir } = await freshInstall(t);
  const before = snapshot(dataDir);
  const report = await runSetup({ dataDir });
  assert.ok(report.verified.includes('demo data'));
  assert.deepEqual(snapshot(dataDir), before);

  const { identity, bank } = open(t, dataDir);
  assert.deepEqual(counts(identity, bank), {
    users: 4, accounts: 4, customers: 3, kyc: 3, wallets: 3, ops: 1, merchants: 1, bankAccounts: 4, sessions: 0,
  });
});

test('setup never resets balances or KYC decisions made after seeding', async (t) => {
  const { dataDir } = await freshInstall(t);
  {
    const { identity, bank } = open(t, dataDir);
    // Simulate activity: a settled $12.50 payment from Alice to Demo Coffee, and Carol approved.
    bank.transaction(() => {
      bank.prepare("INSERT INTO posting VALUES ('p1', 'idem-demo-1', 'MCB-1001', 'MCB-2001', 1250, 2)").run();
      bank.prepare("UPDATE account SET balance_cents = balance_cents - 1250, updated_at = updated_at + 1 WHERE account_ref = 'MCB-1001'").run();
      bank.prepare("UPDATE account SET balance_cents = balance_cents + 1250, updated_at = updated_at + 1 WHERE account_ref = 'MCB-2001'").run();
    })();
    identity.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
      VALUES ('kyc_carol_2', 'cus_demo_carol', 'approved', 'manual', ?, ?)`).run(Date.now() + 1000, Date.now() + 1000);
    identity.close();
    bank.close();
  }
  await runSetup({ dataDir });
  const { identity, bank } = open(t, dataDir);
  assert.equal(balance(bank, 'MCB-1001'), 48_750);
  assert.equal(balance(bank, 'MCB-2001'), 1_250);
  assert.equal(identity.prepare("SELECT status FROM customer_current_kyc WHERE customer_id = 'cus_demo_carol'").get().status, 'approved');
  assert.equal(counts(identity, bank).kyc, 4);
});

test('a missing mock bank database is recreated with opening balances; identity data is kept', async (t) => {
  const { dataDir } = await freshInstall(t);
  const idBefore = snapshot(path.join(dataDir, 'db'))['identity.db'];
  fs.rmSync(path.join(dataDir, 'db', 'mock-core-banking.db'));
  const report = await runSetup({ dataDir });
  assert.ok(report.created.includes('mock-core-banking database'));
  assert.match(report.created.find((c) => c.startsWith('demo data')), /bank account MCB-1001 \(\$500\.00\)/);
  assert.deepEqual(snapshot(path.join(dataDir, 'db'))['identity.db'], idBefore);
});

test('existing data that conflicts with the demo data stops setup instead of being changed', async (t) => {
  const { dataDir } = await freshInstall(t);
  // Recreate the identity DB with a different merchant already holding Demo Coffee's QR code.
  fs.rmSync(path.join(dataDir, 'db', 'identity.db'));
  createDatabase('identity', { dataDir });
  const db = openIdentityDb({ dataDir });
  db.prepare("INSERT INTO merchant (merchant_id, display_name, qr_identifier, core_account_ref, status, created_at) VALUES ('mer_impostor', 'Impostor', 'vaultpay:merchant:demo-coffee', 'MCB-2001', 'active', 1)").run();
  db.close();

  await assert.rejects(runSetup({ dataDir }), /existing merchant mer_demo_coffee does not match the demo data \(merchant_id is "mer_impostor"/);
  const after = openIdentityDb({ dataDir, readonly: true });
  onCleanup(t, () => after.close());
  assert.equal(after.prepare("SELECT display_name FROM merchant WHERE qr_identifier = 'vaultpay:merchant:demo-coffee'").get().display_name, 'Impostor');
});

test('the check fails when a wallet has no mock Core Banking account', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { identity } = open(t, dataDir);
  identity.prepare("INSERT INTO wallet (wallet_id, customer_id, core_account_ref, status, created_at) VALUES ('wal_extra', 'cus_demo_bob', 'MCB-7777', 'active', 1)").run();
  const checks = await runChecks({ dataDir });
  assert.match(checks.filter((c) => c.status === 'fail').map((c) => c.message).join('\n'), /without a mock Core Banking account: MCB-7777/);
});

// ---------------------------------------------------------------------------
test('setup refuses to run with NODE_ENV=production and creates nothing', async (t) => {
  const dataDir = path.join(tempDataDir(t), 'data');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(runSetup({ dataDir }), /refusing to run: NODE_ENV=production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  assert.equal(fs.existsSync(dataDir), false);
});

test('demo data definitions use the reserved example.test domain and match the documented balances', () => {
  for (const u of ALL_LOGINS) assert.match(u.email, /@example\.test$/);
  assert.deepEqual(DEMO_CUSTOMERS.map((c) => [c.email, c.kyc, c.openingBalanceCents]), [
    ['alice@example.test', 'approved', 50_000],
    ['bob@example.test', 'approved', 25_000],
    ['carol@example.test', 'pending', 10_000],
  ]);
  assert.deepEqual(DEMO_MERCHANTS.map((m) => [m.displayName, m.openingBalanceCents]), [['Demo Coffee', 0]]);
});
