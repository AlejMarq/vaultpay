// Demo seeding step of setup (localhost demonstration only – see demo-data.mjs).
//
// Idempotent by design: every item is looked up by its fixed key and created only if it
// is missing. Nothing that already exists is updated, so a repeat run never duplicates
// accounts and never resets balances or KYC status that changed after seeding.
//
// Logins are created through Better Auth's own sign-up API, so passwords are hashed by
// Better Auth exactly as for real sign-ups.

import { betterAuth } from 'better-auth';

import { buildAuthOptions } from '../../lib/server/auth-config.js';
import { openIdentityDb, openMockCoreBankingDb } from '../../lib/server/db/index.js';

import { DEMO_CUSTOMERS, DEMO_KYC_REF, DEMO_MERCHANTS, DEMO_OPS_USERS } from './demo-data.mjs';
import { SetupError } from './paths.mjs';

/**
 * Problems with the demo data in open identity and mock bank connections (empty = OK).
 * Balances and KYC status are not compared: both may change after seeding.
 */
export function inspectDemoData(identity, bank) {
  const problems = [];
  const userId = (email) => identity.prepare('SELECT id FROM "user" WHERE email = ?').get(email)?.id;
  const hasBank = (ref) => Boolean(bank.prepare('SELECT 1 FROM account WHERE account_ref = ?').get(ref));
  for (const c of DEMO_CUSTOMERS) {
    const uid = userId(c.email);
    if (!uid) { problems.push(`missing login ${c.email}`); continue; }
    if (!identity.prepare('SELECT 1 FROM customer WHERE customer_id = ? AND auth_user_id = ?').get(c.customerId, uid)) problems.push(`${c.email} is not linked to customer ${c.customerId}`);
    if (!identity.prepare('SELECT 1 FROM customer_current_kyc WHERE customer_id = ?').get(c.customerId)) problems.push(`${c.customerId} has no KYC record`);
    if (!identity.prepare('SELECT 1 FROM wallet WHERE wallet_id = ? AND customer_id = ? AND core_account_ref = ?').get(c.walletId, c.customerId, c.coreAccountRef)) problems.push(`wallet ${c.walletId} missing or not owned by ${c.customerId}`);
    if (!hasBank(c.coreAccountRef)) problems.push(`mock bank account ${c.coreAccountRef} missing`);
  }
  for (const o of DEMO_OPS_USERS) {
    const uid = userId(o.email);
    if (!uid) problems.push(`missing login ${o.email}`);
    else if (!identity.prepare('SELECT 1 FROM ops_user WHERE ops_user_id = ? AND auth_user_id = ? AND role = ?').get(o.opsUserId, uid, o.role)) problems.push(`${o.email} is not ops user ${o.opsUserId} (${o.role})`);
  }
  for (const m of DEMO_MERCHANTS) {
    if (!identity.prepare('SELECT 1 FROM merchant WHERE merchant_id = ? AND qr_identifier = ? AND core_account_ref = ?').get(m.merchantId, m.qrIdentifier, m.coreAccountRef)) problems.push(`merchant ${m.merchantId} missing`);
    if (!hasBank(m.coreAccountRef)) problems.push(`mock bank account ${m.coreAccountRef} missing`);
  }
  return problems;
}

export function assertNotProduction(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new SetupError('refusing to run: NODE_ENV=production. Setup seeds demo users with published passwords; VaultPay is a localhost demonstration only.');
  }
}

async function ensureLogin(auth, identity, { email, password, name }, created) {
  const find = () => identity.prepare('SELECT id FROM "user" WHERE email = ?').get(email);
  let user = find();
  if (!user) {
    await auth.api.signUpEmail({ body: { email, password, name } });
    user = find();
    if (!user) throw new SetupError(`Better Auth did not create the demo login ${email}`);
    created.push(`login ${email}`);
  }
  return user.id;
}

function ensureBankAccount(bank, { ref, holderType, holderName, openingBalanceCents }, now, created) {
  if (bank.prepare('SELECT 1 FROM account WHERE account_ref = ?').get(ref)) return;
  bank.prepare(`INSERT INTO account (account_ref, holder_type, holder_name, status, balance_cents, opening_balance_cents, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(ref, holderType, holderName, openingBalanceCents, openingBalanceCents, now, now);
  created.push(`bank account ${ref} ($${(openingBalanceCents / 100).toFixed(2)})`);
}

// An existing row must match the demo definition; a mismatch means the data was changed
// by hand or belongs to something else, and setup stops rather than guessing.
function assertMatches(label, row, expected) {
  for (const [k, v] of Object.entries(expected)) {
    if (row[k] !== v) throw new SetupError(`existing ${label} does not match the demo data (${k} is "${row[k]}", expected "${v}"); nothing was changed`);
  }
}

export async function ensureDemoData({ dataDir, authSecret, now = Date.now(), report }) {
  assertNotProduction();
  const created = [];
  const identity = openIdentityDb({ dataDir });
  const bank = openMockCoreBankingDb({ dataDir });
  try {
    const auth = betterAuth(buildAuthOptions({ database: identity, secret: authSecret, baseURL: 'http://localhost:3000', autoSignIn: false }));
    // Better Auth validates its schema in the background after start-up. Wait for that
    // check (failing setup if it fails) so it never runs after the connection is closed.
    const context = await auth.$context;
    await context.checkSchema?.();

    for (const c of DEMO_CUSTOMERS) {
      const userId = await ensureLogin(auth, identity, c, created);
      identity.transaction(() => {
        const customer = identity.prepare('SELECT customer_id, auth_user_id FROM customer WHERE customer_id = ? OR auth_user_id = ?').get(c.customerId, userId);
        if (!customer) {
          identity.prepare(`INSERT INTO customer (customer_id, auth_user_id, full_name, contact_phone, status, created_at)
            VALUES (?, ?, ?, ?, 'active', ?)`).run(c.customerId, userId, c.name, c.phone, now);
          created.push(`customer ${c.customerId}`);
        } else {
          assertMatches(`customer ${c.email}`, customer, { customer_id: c.customerId, auth_user_id: userId });
        }
        // KYC is seeded once; later decisions (e.g. Carol approved during a demo) are kept.
        if (!identity.prepare('SELECT 1 FROM kyc_verification WHERE customer_id = ?').get(c.customerId)) {
          identity.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(`kyc_${c.customerId.slice(4)}`, c.customerId, c.kyc, DEMO_KYC_REF, c.kyc === 'pending' ? null : now, now);
          created.push(`KYC ${c.kyc} for ${c.email}`);
        }
        const wallet = identity.prepare('SELECT wallet_id, customer_id, core_account_ref FROM wallet WHERE wallet_id = ? OR core_account_ref = ?').get(c.walletId, c.coreAccountRef);
        if (!wallet) {
          identity.prepare(`INSERT INTO wallet (wallet_id, customer_id, core_account_ref, status, created_at)
            VALUES (?, ?, ?, 'active', ?)`).run(c.walletId, c.customerId, c.coreAccountRef, now);
          created.push(`wallet ${c.walletId}`);
        } else {
          assertMatches(`wallet ${c.walletId}`, wallet, { wallet_id: c.walletId, customer_id: c.customerId, core_account_ref: c.coreAccountRef });
        }
      })();
      ensureBankAccount(bank, { ref: c.coreAccountRef, holderType: 'customer', holderName: c.name, openingBalanceCents: c.openingBalanceCents }, now, created);
    }

    for (const o of DEMO_OPS_USERS) {
      const userId = await ensureLogin(auth, identity, o, created);
      const ops = identity.prepare('SELECT ops_user_id, auth_user_id, role FROM ops_user WHERE ops_user_id = ? OR auth_user_id = ?').get(o.opsUserId, userId);
      if (!ops) {
        identity.prepare(`INSERT INTO ops_user (ops_user_id, auth_user_id, full_name, role, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)`).run(o.opsUserId, userId, o.name, o.role, now);
        created.push(`ops user ${o.opsUserId} (${o.role})`);
      } else {
        assertMatches(`ops user ${o.email}`, ops, { ops_user_id: o.opsUserId, auth_user_id: userId, role: o.role });
      }
    }

    for (const m of DEMO_MERCHANTS) {
      const merchant = identity.prepare('SELECT merchant_id, qr_identifier, core_account_ref FROM merchant WHERE merchant_id = ? OR qr_identifier = ? OR core_account_ref = ?')
        .get(m.merchantId, m.qrIdentifier, m.coreAccountRef);
      if (!merchant) {
        identity.prepare(`INSERT INTO merchant (merchant_id, display_name, qr_identifier, core_account_ref, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)`).run(m.merchantId, m.displayName, m.qrIdentifier, m.coreAccountRef, now);
        created.push(`merchant ${m.merchantId}`);
      } else {
        assertMatches(`merchant ${m.merchantId}`, merchant, { merchant_id: m.merchantId, qr_identifier: m.qrIdentifier, core_account_ref: m.coreAccountRef });
      }
      ensureBankAccount(bank, { ref: m.coreAccountRef, holderType: 'merchant', holderName: m.displayName, openingBalanceCents: m.openingBalanceCents }, now, created);
    }
  } finally {
    bank.close();
    identity.close();
  }

  if (created.length) report.created.push(`demo data (${created.join(', ')})`);
  else report.verified.push('demo data');
}
