// Orchestrator & Ledger: the transfer writer (Step 5).
//
// The only code that creates transfers. It runs on its own writable transaction-DB
// connection and exposes one operation, create(), which in ONE database transaction:
//   - resolves the idempotency key (same key + same payload → the stored transfer;
//     same key + different payload → refused),
//   - applies the preliminary funds check against the Core Banking balance minus this
//     wallet's transfers that are still on hold (not final),
//   - inserts the transfer as pending_risk, its transfer.requested audit event and its
//     fraud_check outbox message.
// Either all three rows exist or none does. Nothing here moves money or marks a transfer
// completed: fraud screening (Step 6) and settlement (Step 7) pick it up from the outbox.
//
// SQLite has no per-connection permissions, so "narrow" is enforced by this module's API
// and by the schema triggers (D3), as for the support audit writer.

import crypto from 'node:crypto';

import { assertNotBuilding } from './auth.js';
import { defaultDataDir } from './db/definitions.js';
import { openTransactionDb } from './db/index.js';
import { CURRENCY, MAX_TRANSFER_CENTS, MIN_TRANSFER_CENTS } from './money.js';

// Mirrors the transfer_valid_status_transition trigger (transaction migration 0001).
export const TRANSFER_TRANSITIONS = Object.freeze({
  pending_risk: Object.freeze(['pending_settlement', 'declined', 'expired']),
  pending_settlement: Object.freeze(['settlement_in_flight', 'pending_risk', 'expired']),
  settlement_in_flight: Object.freeze(['completed', 'failed']),
  completed: Object.freeze([]),
  declined: Object.freeze([]),
  failed: Object.freeze([]),
  expired: Object.freeze([]),
});

export const canTransition = (from, to) => TRANSFER_TRANSITIONS[from]?.includes(to) ?? false;

// Not final yet: the money may still leave the wallet, so it is held against the balance.
export const HOLDING_STATUSES = Object.freeze(['pending_risk', 'pending_settlement', 'settlement_in_flight']);

// A transfer that is not screened and settled within this window expires (Step 6/7 job).
export const PENDING_WINDOW_MS = 60 * 60 * 1000;

export const TRANSFER_EVENTS = Object.freeze({ requested: 'transfer.requested' });

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const WALLET_ID = /^wal_[A-Za-z0-9_]{1,60}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,60}$/;

/** A business refusal with a stable code (shown to the customer as a fixed message). */
export class TransferRejected extends Error {
  constructor(code) {
    super(`transfer rejected: ${code}`);
    this.name = 'TransferRejected';
    this.code = code; // 'idempotency_conflict' | 'insufficient_funds' | 'invalid_request'
  }
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

const HOLDS_SQL = `SELECT coalesce(sum(amount_cents), 0) AS cents FROM transfer
  WHERE sender_wallet_id = ? AND status IN (${HOLDING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/** Total of a wallet's outgoing transfers that are not final yet (any connection). */
export function pendingOutgoingCents(transactionDb, walletId) {
  return transactionDb.prepare(HOLDS_SQL).get(walletId).cents;
}

const view = (row) => Object.freeze({
  transferId: row.transfer_id,
  senderWalletId: row.sender_wallet_id,
  payeeType: row.payee_type,
  payeeId: row.payee_id,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  createdAt: row.created_at,
});

/** `db`: a writable transaction DB connection used for nothing else. */
export function createTransferWriter(db, { now = () => Date.now() } = {}) {
  const byKey = db.prepare(`SELECT transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, currency, status, created_at
    FROM transfer WHERE sender_wallet_id = ? AND idempotency_key = ?`);
  const holds = db.prepare(HOLDS_SQL);
  const insertTransfer = db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, currency,
      idempotency_key, status, pending_expires_at, settlement_attempted_at, created_at, updated_at)
    VALUES (?, ?, 'wallet', ?, ?, ?, ?, 'pending_risk', ?, NULL, ?, ?)`);
  const insertAudit = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, ?, ?, 'customer', ?, ?, ?)`);
  const insertOutbox = db.prepare(`INSERT INTO outbox_message (message_id, transfer_id, target, status, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at)
    VALUES (?, ?, 'fraud_check', 'pending', 0, ?, NULL, NULL, ?, ?)`);

  const sameRequest = (row, r) => row.payee_type === 'wallet' && row.payee_id === r.recipientWalletId
    && row.amount_cents === r.amountCents && row.currency === r.currency;

  const resolveExisting = (row, r) => {
    if (!sameRequest(row, r)) throw new TransferRejected('idempotency_conflict');
    return Object.freeze({ transfer: view(row), replayed: true });
  };

  const validate = (r) => {
    const ok = r && typeof r === 'object'
      && CUSTOMER_ID.test(r.customerId ?? '')
      && WALLET_ID.test(r.senderWalletId ?? '') && WALLET_ID.test(r.recipientWalletId ?? '')
      && r.senderWalletId !== r.recipientWalletId
      && Number.isSafeInteger(r.amountCents) && r.amountCents >= MIN_TRANSFER_CENTS && r.amountCents <= MAX_TRANSFER_CENTS
      && r.currency === CURRENCY
      && IDEMPOTENCY_KEY.test(r.idempotencyKey ?? '');
    if (!ok) throw new TransferRejected('invalid_request');
  };

  const write = db.transaction((r) => {
    const existing = byKey.get(r.senderWalletId, r.idempotencyKey);
    if (existing) return resolveExisting(existing, r);

    // Preliminary only: the Core Banking posting in Step 7 enforces funds independently.
    if (!Number.isSafeInteger(r.balanceCents) || r.balanceCents - holds.get(r.senderWalletId).cents < r.amountCents) {
      throw new TransferRejected('insufficient_funds');
    }

    const at = now();
    const transferId = newId('trf');
    insertTransfer.run(transferId, r.senderWalletId, r.recipientWalletId, r.amountCents, r.currency, r.idempotencyKey, at + PENDING_WINDOW_MS, at, at);
    insertAudit.run(newId('aud'), transferId, r.senderWalletId, r.customerId, TRANSFER_EVENTS.requested, at);
    insertOutbox.run(newId('obx'), transferId, at, at, at);
    return Object.freeze({ transfer: view(byKey.get(r.senderWalletId, r.idempotencyKey)), replayed: false });
  });

  return Object.freeze({
    /** The transfer already recorded for this sender and key, or null (no write). */
    find({ senderWalletId, idempotencyKey }) {
      const row = byKey.get(senderWalletId, idempotencyKey);
      return row ? view(row) : null;
    },

    /**
     * request: { customerId, senderWalletId, recipientWalletId, amountCents, currency,
     * idempotencyKey, balanceCents }. Returns { transfer, replayed }. Throws
     * TransferRejected, or the database error (nothing was written).
     */
    create(request) {
      validate(request);
      try {
        // BEGIN IMMEDIATE: concurrent writers (other connections) wait, so the
        // idempotency lookup and the holds total are read under the write lock.
        return write.immediate(request);
      } catch (err) {
        // Belt and braces: if another connection won the race on the unique
        // (sender_wallet_id, idempotency_key) index, answer from its row.
        if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          const row = byKey.get(request.senderWalletId, request.idempotencyKey);
          if (row) return resolveExisting(row, request);
        }
        throw err;
      }
    },
  });
}

const WRITER = Symbol.for('vaultpay.transfer-writer');

export function transferWriter() {
  assertNotBuilding();
  globalThis[WRITER] ??= createTransferWriter(openTransactionDb({ dataDir: defaultDataDir() }));
  return globalThis[WRITER];
}
