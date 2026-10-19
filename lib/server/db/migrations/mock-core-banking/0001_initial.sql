-- Mock Core Banking DB – schema v1
-- A stand-in for the partner Core Banking System, which VaultPay does not control.
-- It is the source of truth for balances (D7) and performs the final funds check.
-- Opened only by the mock Core Banking process, never by VaultPay services.

-- ---------------------------------------------------------------------------
-- Accounts – one per VaultPay wallet or merchant (wallet.core_account_ref,
-- merchant.core_account_ref in the identity DB)
-- ---------------------------------------------------------------------------
CREATE TABLE account (
  account_ref           TEXT    PRIMARY KEY CHECK (length(account_ref) BETWEEN 1 AND 64),
  holder_type           TEXT    NOT NULL CHECK (holder_type IN ('customer', 'merchant')),
  holder_name           TEXT    NOT NULL CHECK (length(holder_name) BETWEEN 1 AND 200),
  currency              TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status                TEXT    NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  -- the bank refuses any posting that would take an account below zero
  balance_cents         INTEGER NOT NULL CHECK (balance_cents >= 0),
  opening_balance_cents INTEGER NOT NULL CHECK (opening_balance_cents >= 0),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL,
  CHECK (updated_at >= created_at)
) STRICT;

CREATE TRIGGER account_immutable_columns BEFORE UPDATE ON account
WHEN NEW.account_ref IS NOT OLD.account_ref
  OR NEW.holder_type IS NOT OLD.holder_type
  OR NEW.currency IS NOT OLD.currency
  OR NEW.opening_balance_cents IS NOT OLD.opening_balance_cents
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'account reference, holder type, currency and opening balance cannot change'); END;

CREATE TRIGGER account_no_delete BEFORE DELETE ON account
BEGIN SELECT RAISE(ABORT, 'accounts are closed, not deleted'); END;

-- ---------------------------------------------------------------------------
-- Postings – append-only record of every settlement the bank accepted.
-- The idempotency key is the one VaultPay sends (settlement_attempt.idempotency_key),
-- so a retried request is recognised instead of being posted twice (282).
-- ---------------------------------------------------------------------------
CREATE TABLE posting (
  posting_ref     TEXT    PRIMARY KEY CHECK (length(posting_ref) BETWEEN 1 AND 64),
  idempotency_key TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  debit_account   TEXT    NOT NULL REFERENCES account(account_ref),
  credit_account  TEXT    NOT NULL REFERENCES account(account_ref),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (debit_account <> credit_account)
) STRICT;

CREATE INDEX posting_by_debit ON posting (debit_account, created_at);
CREATE INDEX posting_by_credit ON posting (credit_account, created_at);

CREATE TRIGGER posting_no_update BEFORE UPDATE ON posting
BEGIN SELECT RAISE(ABORT, 'postings are append-only'); END;

CREATE TRIGGER posting_no_delete BEFORE DELETE ON posting
BEGIN SELECT RAISE(ABORT, 'postings are append-only'); END;
