-- VaultPay Transaction DB – schema v1
-- Written by Orchestrator & Ledger and Reconciliation & Audit only (D3); read by
-- Ops Support through read-only connections. Wallet, merchant, customer and ops-user
-- IDs are logical references into the identity DB: never joined, validated by their owner.
--
-- Conventions: STRICT tables; random prefixed text IDs; money is integer cents;
-- timestamps are integer milliseconds since the Unix epoch (UTC).

-- ---------------------------------------------------------------------------
-- Transfers
-- Status flow:
--   pending_risk ──► pending_settlement ──► settlement_in_flight ──► completed
--        │  ▲               │                       └──────────────► failed
--        │  └── re-screen ──┤
--        ├──► declined      └──► expired (only before settlement was attempted, D5)
--        └──► expired
-- settlement_in_flight also covers "sent, outcome unknown"; it never expires (D5).
-- ---------------------------------------------------------------------------
CREATE TABLE transfer (
  transfer_id             TEXT    PRIMARY KEY CHECK (transfer_id GLOB 'trf_?*' AND length(transfer_id) <= 64),
  sender_wallet_id        TEXT    NOT NULL CHECK (sender_wallet_id GLOB 'wal_?*' AND length(sender_wallet_id) <= 64),
  payee_type              TEXT    NOT NULL CHECK (payee_type IN ('wallet', 'merchant')),
  payee_id                TEXT    NOT NULL CHECK (length(payee_id) <= 64),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000),
  currency                TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- unique per sender, not globally (deviation from Assignment 5)
  idempotency_key         TEXT    NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status                  TEXT    NOT NULL CHECK (status IN (
                            'pending_risk', 'pending_settlement', 'settlement_in_flight',
                            'completed', 'declined', 'failed', 'expired')),
  pending_expires_at      INTEGER,
  settlement_attempted_at INTEGER,
  created_at              INTEGER NOT NULL CHECK (created_at > 0),
  updated_at              INTEGER NOT NULL,
  UNIQUE (sender_wallet_id, idempotency_key),
  CHECK ((payee_type = 'wallet' AND payee_id GLOB 'wal_?*' AND payee_id <> sender_wallet_id)
      OR (payee_type = 'merchant' AND payee_id GLOB 'mer_?*')),
  CHECK (status NOT IN ('pending_risk', 'pending_settlement') OR pending_expires_at IS NOT NULL),
  CHECK (status NOT IN ('settlement_in_flight', 'completed') OR settlement_attempted_at IS NOT NULL),
  -- D5: once a settlement request may have been sent, the transfer can never expire
  CHECK (status <> 'expired' OR settlement_attempted_at IS NULL),
  -- ...and cannot go back for re-screening
  CHECK (status <> 'pending_risk' OR settlement_attempted_at IS NULL),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX transfer_by_sender ON transfer (sender_wallet_id, created_at);
CREATE INDEX transfer_by_status ON transfer (status, pending_expires_at);

CREATE TRIGGER transfer_insert_starts_pending BEFORE INSERT ON transfer
WHEN NEW.status <> 'pending_risk' OR NEW.settlement_attempted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a new transfer must start as pending_risk'); END;

CREATE TRIGGER transfer_immutable_columns BEFORE UPDATE ON transfer
WHEN NEW.transfer_id IS NOT OLD.transfer_id
  OR NEW.sender_wallet_id IS NOT OLD.sender_wallet_id
  OR NEW.payee_type IS NOT OLD.payee_type
  OR NEW.payee_id IS NOT OLD.payee_id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.currency IS NOT OLD.currency
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'transfer parties, amount and idempotency key cannot change'); END;

CREATE TRIGGER transfer_settlement_attempt_is_permanent BEFORE UPDATE OF settlement_attempted_at ON transfer
WHEN OLD.settlement_attempted_at IS NOT NULL
  AND NEW.settlement_attempted_at IS NOT OLD.settlement_attempted_at
BEGIN SELECT RAISE(ABORT, 'settlement_attempted_at cannot be changed once recorded'); END;

CREATE TRIGGER transfer_valid_status_transition BEFORE UPDATE OF status ON transfer
WHEN NEW.status IS NOT OLD.status AND NOT (
     (OLD.status = 'pending_risk'         AND NEW.status IN ('pending_settlement', 'declined', 'expired'))
  OR (OLD.status = 'pending_settlement'   AND NEW.status IN ('settlement_in_flight', 'pending_risk', 'expired'))
  OR (OLD.status = 'settlement_in_flight' AND NEW.status IN ('completed', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid transfer status transition'); END;

CREATE TRIGGER transfer_no_delete BEFORE DELETE ON transfer
BEGIN SELECT RAISE(ABORT, 'transfers cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Ledger – append-only; corrections are reversing entries
-- (deviation from Assignment 5: account_type/account_id so merchants can be credited)
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entry (
  entry_id          TEXT    PRIMARY KEY CHECK (entry_id GLOB 'led_?*' AND length(entry_id) <= 64),
  transfer_id       TEXT    NOT NULL REFERENCES transfer(transfer_id),
  account_type      TEXT    NOT NULL CHECK (account_type IN ('wallet', 'merchant')),
  account_id        TEXT    NOT NULL CHECK (length(account_id) <= 64),
  direction         TEXT    NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000),
  currency          TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reverses_entry_id TEXT    UNIQUE REFERENCES ledger_entry(entry_id),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  CHECK ((account_type = 'wallet' AND account_id GLOB 'wal_?*')
      OR (account_type = 'merchant' AND account_id GLOB 'mer_?*'))
) STRICT;

CREATE INDEX ledger_entry_by_account ON ledger_entry (account_type, account_id, created_at);

-- Each completed transfer posts exactly one debit and one credit; a retry cannot double-post.
CREATE UNIQUE INDEX ledger_one_posting_per_side ON ledger_entry (transfer_id, direction)
WHERE reverses_entry_id IS NULL;

-- A posting must match its transfer: completed, same amount, debit the sender, credit the payee.
CREATE TRIGGER ledger_posting_matches_transfer BEFORE INSERT ON ledger_entry
WHEN NEW.reverses_entry_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM transfer AS t
  WHERE t.transfer_id = NEW.transfer_id
    AND t.status = 'completed'
    AND t.amount_cents = NEW.amount_cents
    AND t.currency = NEW.currency
    AND ((NEW.direction = 'debit'  AND NEW.account_type = 'wallet'     AND NEW.account_id = t.sender_wallet_id)
      OR (NEW.direction = 'credit' AND NEW.account_type = t.payee_type AND NEW.account_id = t.payee_id))
)
BEGIN SELECT RAISE(ABORT, 'ledger posting does not match a completed transfer'); END;

-- A reversal must exactly mirror an original (non-reversal) entry of the same transfer.
CREATE TRIGGER ledger_reversal_mirrors_original BEFORE INSERT ON ledger_entry
WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_entry AS o
  WHERE o.entry_id = NEW.reverses_entry_id
    AND o.reverses_entry_id IS NULL
    AND o.transfer_id = NEW.transfer_id
    AND o.account_type = NEW.account_type
    AND o.account_id = NEW.account_id
    AND o.direction <> NEW.direction
    AND o.amount_cents = NEW.amount_cents
    AND o.currency = NEW.currency
)
BEGIN SELECT RAISE(ABORT, 'reversal must mirror an original entry of the same transfer'); END;

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

-- ---------------------------------------------------------------------------
-- Risk decisions – signed by Fraud & Risk Check, stored by the Orchestrator
-- signature holds the compact JWS produced with jose (D10).
-- (deviation from Assignment 5: risk_score is an integer 0–1000, not a decimal)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_decision (
  decision_id TEXT    PRIMARY KEY CHECK (decision_id GLOB 'rsk_?*' AND length(decision_id) <= 64),
  transfer_id TEXT    NOT NULL REFERENCES transfer(transfer_id),
  outcome     TEXT    NOT NULL CHECK (outcome IN ('approve', 'decline')),
  risk_score  INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 1000),
  signature   TEXT    NOT NULL CHECK (length(signature) BETWEEN 16 AND 4096),
  key_version TEXT    NOT NULL CHECK (length(key_version) BETWEEN 1 AND 64),
  issued_at   INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (expires_at > issued_at)
) STRICT;

CREATE INDEX risk_decision_by_transfer ON risk_decision (transfer_id);

CREATE TRIGGER risk_decision_no_update BEFORE UPDATE ON risk_decision
BEGIN SELECT RAISE(ABORT, 'risk decisions are append-only'); END;

CREATE TRIGGER risk_decision_no_delete BEFORE DELETE ON risk_decision
BEGIN SELECT RAISE(ABORT, 'risk decisions are append-only'); END;

-- ---------------------------------------------------------------------------
-- Settlement attempts – recorded before the request leaves (D5)
-- (deviation from Assignment 5: SettlementRecord renamed; adds requested_at,
--  attempt_no and the idempotency key sent to Core Banking)
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_attempt (
  attempt_id       TEXT    PRIMARY KEY CHECK (attempt_id GLOB 'stl_?*' AND length(attempt_id) <= 64),
  transfer_id      TEXT    NOT NULL REFERENCES transfer(transfer_id),
  decision_id      TEXT    NOT NULL REFERENCES risk_decision(decision_id),
  attempt_no       INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 100),
  idempotency_key  TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  requested_at     INTEGER NOT NULL CHECK (requested_at > 0),
  outcome          TEXT    NOT NULL CHECK (outcome IN ('pending', 'settled', 'failed', 'unknown')),
  core_banking_ref TEXT    CHECK (core_banking_ref IS NULL OR length(core_banking_ref) BETWEEN 1 AND 128),
  completed_at     INTEGER,
  UNIQUE (transfer_id, attempt_no),
  CHECK ((outcome IN ('settled', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (outcome <> 'settled' OR core_banking_ref IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
) STRICT;

-- Only an approved decision for this same transfer may be settled, and only after the
-- transfer has recorded that a settlement request is being sent.
CREATE TRIGGER settlement_attempt_requires_approval BEFORE INSERT ON settlement_attempt
WHEN NEW.outcome <> 'pending'
  OR NOT EXISTS (SELECT 1 FROM risk_decision AS d
                 WHERE d.decision_id = NEW.decision_id
                   AND d.transfer_id = NEW.transfer_id
                   AND d.outcome = 'approve')
  OR NOT EXISTS (SELECT 1 FROM transfer AS t
                 WHERE t.transfer_id = NEW.transfer_id
                   AND t.settlement_attempted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'settlement attempt needs a pending outcome, an approved decision for the same transfer, and settlement_attempted_at'); END;

-- Only the outcome may change, and only while it is still pending or unknown.
CREATE TRIGGER settlement_attempt_outcome_only BEFORE UPDATE ON settlement_attempt
WHEN OLD.outcome NOT IN ('pending', 'unknown')
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.transfer_id IS NOT OLD.transfer_id
  OR NEW.decision_id IS NOT OLD.decision_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'only a pending or unknown settlement outcome can be updated'); END;

CREATE TRIGGER settlement_attempt_no_delete BEFORE DELETE ON settlement_attempt
BEGIN SELECT RAISE(ABORT, 'settlement attempts cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Outbox – committed in the same transaction as the state change it announces (307)
-- next_attempt_at and lease_until are separate fields (D8)
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_message (
  message_id      TEXT    PRIMARY KEY CHECK (message_id GLOB 'obx_?*' AND length(message_id) <= 64),
  transfer_id     TEXT    NOT NULL REFERENCES transfer(transfer_id),
  target          TEXT    NOT NULL CHECK (target IN ('fraud_check', 'settlement')),
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'leased', 'done', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  next_attempt_at INTEGER NOT NULL,
  lease_until     INTEGER,
  last_error      TEXT    CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL,
  CHECK ((status = 'leased') = (lease_until IS NOT NULL)),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX outbox_message_due ON outbox_message (status, next_attempt_at);

-- At most one live message per transfer and target, so a retried request cannot enqueue twice.
CREATE UNIQUE INDEX outbox_one_live_message ON outbox_message (transfer_id, target)
WHERE status IN ('pending', 'leased');

CREATE TRIGGER outbox_message_insert_pending BEFORE INSERT ON outbox_message
WHEN NEW.status <> 'pending' OR NEW.attempts <> 0
BEGIN SELECT RAISE(ABORT, 'a new outbox message must be pending with no attempts'); END;

CREATE TRIGGER outbox_message_immutable_columns BEFORE UPDATE ON outbox_message
WHEN NEW.message_id IS NOT OLD.message_id
  OR NEW.transfer_id IS NOT OLD.transfer_id
  OR NEW.target IS NOT OLD.target
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempts < OLD.attempts
  OR OLD.status IN ('done', 'dead')
BEGIN SELECT RAISE(ABORT, 'outbox message identity is fixed, attempts only grow, and done/dead are final'); END;

CREATE TRIGGER outbox_message_no_delete BEFORE DELETE ON outbox_message
BEGIN SELECT RAISE(ABORT, 'outbox messages cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Audit trail – append-only (written by Reconciliation & Audit)
-- event_type is format-checked here; the list of event types is fixed in a later migration.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  event_id          TEXT    PRIMARY KEY CHECK (event_id GLOB 'aud_?*' AND length(event_id) <= 64),
  transfer_id       TEXT    REFERENCES transfer(transfer_id),
  subject_wallet_id TEXT    CHECK (subject_wallet_id IS NULL OR (subject_wallet_id GLOB 'wal_?*' AND length(subject_wallet_id) <= 64)),
  actor_type        TEXT    NOT NULL CHECK (actor_type IN ('customer', 'ops_user', 'service')),
  actor_id          TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 64),
  event_type        TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64 AND event_type NOT GLOB '*[^a-z0-9_.]*'),
  occurred_at       INTEGER NOT NULL CHECK (occurred_at > 0)
) STRICT;

CREATE INDEX audit_event_by_transfer ON audit_event (transfer_id);
CREATE INDEX audit_event_by_time ON audit_event (occurred_at);

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;

CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;

-- ---------------------------------------------------------------------------
-- Reconciliation results – append-only; mismatches are alerted, never auto-corrected
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_result (
  reconciliation_id TEXT    PRIMARY KEY CHECK (reconciliation_id GLOB 'rec_?*' AND length(reconciliation_id) <= 64),
  transfer_id       TEXT    NOT NULL REFERENCES transfer(transfer_id),
  core_banking_ref  TEXT    CHECK (core_banking_ref IS NULL OR length(core_banking_ref) BETWEEN 1 AND 128),
  result            TEXT    NOT NULL CHECK (result IN ('matched', 'mismatched')),
  difference_cents  INTEGER,
  checked_at        INTEGER NOT NULL CHECK (checked_at > 0),
  CHECK (result = 'mismatched' OR difference_cents IS NULL)
) STRICT;

CREATE INDEX reconciliation_result_by_transfer ON reconciliation_result (transfer_id);

CREATE TRIGGER reconciliation_result_no_update BEFORE UPDATE ON reconciliation_result
BEGIN SELECT RAISE(ABORT, 'reconciliation results are append-only'); END;

CREATE TRIGGER reconciliation_result_no_delete BEFORE DELETE ON reconciliation_result
BEGIN SELECT RAISE(ABORT, 'reconciliation results are append-only'); END;
