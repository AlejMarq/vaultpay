// Append-only audit writer for support access (Step 3, Section 3D).
//
// Ops Support itself never writes customer, wallet, KYC or transfer data: its reads go
// through read-only connections. Recording *that* support looked at an account is the
// one write it causes, and it happens here, on a separate connection that exposes a
// single prepared INSERT into audit_event – nothing else. The database adds its own
// guards: audit_event cannot be updated or deleted, and only registered event types
// (transaction migration 0002) are accepted.
//
// SQLite has no per-connection permissions, so "narrow" is enforced by this module's API
// and by the triggers, not by the database engine (D3).

import crypto from 'node:crypto';

import { assertNotBuilding } from './auth.js';
import { defaultDataDir } from './db/definitions.js';
import { openTransactionDb } from './db/index.js';

export const SUPPORT_EVENTS = Object.freeze({
  search: 'support.customer_search',
  view: 'support.customer_view',
  operationsView: 'support.operations_view', // Step 8: the read-only operations overview
});
const ALLOWED = new Set(Object.values(SUPPORT_EVENTS));

const newEventId = () => `aud_${crypto.randomBytes(12).toString('hex')}`;

/** `db`: a writable transaction DB connection used for nothing else. */
export function createAuditWriter(db, { now = () => Date.now() } = {}) {
  const insert = db.prepare(`INSERT INTO audit_event (event_id, transfer_id, subject_wallet_id, actor_type, actor_id, event_type, occurred_at)
    VALUES (?, NULL, ?, 'ops_user', ?, ?, ?)`);
  return Object.freeze({
    /** Records one support access. Throws if it cannot be recorded (callers fail closed). */
    recordSupportAccess({ opsUserId, eventType, subjectWalletId = null }) {
      if (!ALLOWED.has(eventType)) throw new Error(`not a support audit event: ${eventType}`);
      if (typeof opsUserId !== 'string' || !/^ops_[A-Za-z0-9_]{1,60}$/.test(opsUserId)) throw new Error('invalid ops user id');
      const eventId = newEventId();
      insert.run(eventId, subjectWalletId, opsUserId, eventType, now());
      return eventId;
    },
  });
}

const WRITER = Symbol.for('vaultpay.audit-writer');

export function auditWriter() {
  assertNotBuilding();
  globalThis[WRITER] ??= createAuditWriter(openTransactionDb({ dataDir: defaultDataDir() }));
  return globalThis[WRITER];
}
