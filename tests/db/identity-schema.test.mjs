import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addAuthUserStub, assertRejected, freshDb, T0 } from '../helpers/db.mjs';

function setup(t) {
  const { db } = freshDb(t, 'identity');
  addAuthUserStub(db, 'usr_alice', 'usr_bob', 'usr_support');
  return db;
}

const addCustomer = (db, id, userId, status = 'active') =>
  db.prepare(`INSERT INTO customer (customer_id, auth_user_id, full_name, contact_phone, status, created_at)
    VALUES (?, ?, 'Test Customer', '+1-555-0100', ?, ${T0})`).run(id, userId, status);

const addOps = (db, id, userId, role = 'support_readonly') =>
  db.prepare(`INSERT INTO ops_user (ops_user_id, auth_user_id, full_name, role, status, created_at)
    VALUES (?, ?, 'Support Agent', ?, 'active', ${T0})`).run(id, userId, role);

const addKyc = (db, id, customerId, status, verifiedAt, createdAt = T0) =>
  db.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
    VALUES (?, ?, ?, 'mock-kyc-ref', ?, ?)`).run(id, customerId, status, verifiedAt, createdAt);

const addWallet = (db, id, customerId, ref, currency = 'USD') =>
  db.prepare(`INSERT INTO wallet (wallet_id, customer_id, core_account_ref, currency, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ${T0})`).run(id, customerId, ref, currency);

// ---------------------------------------------------------------------------
test('customer: must belong to an existing login, one customer per login', (t) => {
  const db = setup(t);
  assertRejected(() => addCustomer(db, 'cus_ghost', 'usr_missing'), 'FOREIGN KEY');
  addCustomer(db, 'cus_alice', 'usr_alice');
  assertRejected(() => addCustomer(db, 'cus_alice2', 'usr_alice'), 'UNIQUE');
  assertRejected(() => addCustomer(db, 'alice', 'usr_bob'), 'CHECK');
  assertRejected(() => addCustomer(db, 'cus_bob', 'usr_bob', 'vip'), 'CHECK');
});

test('customer: login and id are fixed, closed is final, no deletes', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  assertRejected(() => db.prepare("UPDATE customer SET auth_user_id = 'usr_bob'").run(), 'cannot change');
  db.prepare("UPDATE customer SET status = 'closed'").run();
  assertRejected(() => db.prepare("UPDATE customer SET status = 'active'").run(), 'cannot be reopened');
  assertRejected(() => db.prepare('DELETE FROM customer').run(), 'not deleted');
});

test('roles: a login is either a customer or an ops user, never both', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  addOps(db, 'ops_support', 'usr_support');
  assertRejected(() => addOps(db, 'ops_alice', 'usr_alice'), 'already belongs to a customer');
  assertRejected(() => addCustomer(db, 'cus_support', 'usr_support'), 'already belongs to an ops user');
  assertRejected(() => addOps(db, 'ops_bob', 'usr_bob', 'admin'), 'CHECK');
  assertRejected(() => db.prepare("UPDATE ops_user SET auth_user_id = 'usr_bob'").run(), 'cannot change');
  assertRejected(() => db.prepare('DELETE FROM ops_user').run(), 'not deleted');
});

test('KYC: history is append-only and decision times are consistent', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  assertRejected(() => addKyc(db, 'kyc_bad1', 'cus_alice', 'pending', T0), 'CHECK');
  assertRejected(() => addKyc(db, 'kyc_bad2', 'cus_alice', 'approved', null), 'CHECK');
  assertRejected(() => addKyc(db, 'kyc_bad3', 'cus_alice', 'maybe', null), 'CHECK');
  assertRejected(() => addKyc(db, 'kyc_bad4', 'cus_nobody', 'pending', null), 'FOREIGN KEY');

  addKyc(db, 'kyc_1', 'cus_alice', 'pending', null);
  assertRejected(() => db.prepare("UPDATE kyc_verification SET status = 'approved', verified_at = 1").run(), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM kyc_verification').run(), 'append-only');
});

test('KYC: current status is the newest record', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  addCustomer(db, 'cus_bob', 'usr_bob');
  addKyc(db, 'kyc_a1', 'cus_alice', 'pending', null, T0);
  addKyc(db, 'kyc_a2', 'cus_alice', 'approved', T0 + 100, T0 + 100);
  addKyc(db, 'kyc_b1', 'cus_bob', 'pending', null, T0);

  const current = db.prepare('SELECT customer_id, status FROM customer_current_kyc ORDER BY customer_id').all();
  assert.deepEqual(current, [
    { customer_id: 'cus_alice', status: 'approved' },
    { customer_id: 'cus_bob', status: 'pending' },
  ]);
});

test('wallet: maps one-to-one to a Core Banking account, USD only', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  addCustomer(db, 'cus_bob', 'usr_bob');
  addWallet(db, 'wal_alice', 'cus_alice', 'CB-0001');
  assertRejected(() => addWallet(db, 'wal_bob', 'cus_bob', 'CB-0001'), 'UNIQUE');
  assertRejected(() => addWallet(db, 'wal_bob', 'cus_bob', 'CB-0002', 'EUR'), 'CHECK');
  assertRejected(() => addWallet(db, 'wal_x', 'cus_nobody', 'CB-0003'), 'FOREIGN KEY');
});

test('wallet: owner and account mapping are fixed, closed is final, no deletes', (t) => {
  const db = setup(t);
  addCustomer(db, 'cus_alice', 'usr_alice');
  addCustomer(db, 'cus_bob', 'usr_bob');
  addWallet(db, 'wal_alice', 'cus_alice', 'CB-0001');
  assertRejected(() => db.prepare("UPDATE wallet SET customer_id = 'cus_bob'").run(), 'cannot change');
  assertRejected(() => db.prepare("UPDATE wallet SET core_account_ref = 'CB-9999'").run(), 'cannot change');
  db.prepare("UPDATE wallet SET status = 'frozen'").run();
  db.prepare("UPDATE wallet SET status = 'closed'").run();
  assertRejected(() => db.prepare("UPDATE wallet SET status = 'active'").run(), 'cannot be reopened');
  assertRejected(() => db.prepare('DELETE FROM wallet').run(), 'not deleted');
});

test('merchant: unique QR identifier and account; identity fixed', (t) => {
  const db = setup(t);
  const add = (id, qr, ref) => db.prepare(`INSERT INTO merchant (merchant_id, display_name, qr_identifier, core_account_ref, status, created_at)
    VALUES (?, 'Demo Coffee', ?, ?, 'active', ${T0})`).run(id, qr, ref);
  add('mer_coffee', 'vaultpay:merchant:coffee', 'CB-M-0001');
  assertRejected(() => add('mer_copy', 'vaultpay:merchant:coffee', 'CB-M-0002'), 'UNIQUE');
  assertRejected(() => add('mer_short', 'short', 'CB-M-0003'), 'CHECK');
  assertRejected(() => db.prepare("UPDATE merchant SET qr_identifier = 'vaultpay:merchant:other'").run(), 'cannot change');
  assertRejected(() => db.prepare('DELETE FROM merchant').run(), 'not deleted');
});
