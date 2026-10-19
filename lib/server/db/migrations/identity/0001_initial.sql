-- VaultPay Customer & Identity DB – schema v1
-- Owned by Identity, Access & KYC. Better Auth adds its own tables (user, session, account,
-- verification, twoFactor) to this file during setup; this migration never touches them.
--
-- Conventions: STRICT tables; random prefixed text IDs; timestamps are integer
-- milliseconds since the Unix epoch (UTC); allowed values enforced with CHECK.
-- "user" is quoted because it is Better Auth's table name and an SQL keyword.

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE customer (
  customer_id   TEXT    PRIMARY KEY CHECK (customer_id GLOB 'cus_?*' AND length(customer_id) <= 64),
  auth_user_id  TEXT    NOT NULL UNIQUE REFERENCES "user"(id),
  full_name     TEXT    NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  contact_phone TEXT    CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 3 AND 32),
  status        TEXT    NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  created_at    INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TRIGGER customer_immutable_columns BEFORE UPDATE ON customer
WHEN NEW.customer_id IS NOT OLD.customer_id
  OR NEW.auth_user_id IS NOT OLD.auth_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'customer id, login and creation time cannot change'); END;

CREATE TRIGGER customer_closed_is_final BEFORE UPDATE OF status ON customer
WHEN OLD.status = 'closed' AND NEW.status <> 'closed'
BEGIN SELECT RAISE(ABORT, 'a closed customer cannot be reopened'); END;

CREATE TRIGGER customer_no_delete BEFORE DELETE ON customer
BEGIN SELECT RAISE(ABORT, 'customers are closed, not deleted'); END;

-- ---------------------------------------------------------------------------
-- KYC – append-only history; the newest row is the customer's current status
-- (deviation from Assignment 5: history kept instead of one updatable row)
-- ---------------------------------------------------------------------------
CREATE TABLE kyc_verification (
  verification_id  TEXT    PRIMARY KEY CHECK (verification_id GLOB 'kyc_?*' AND length(verification_id) <= 64),
  customer_id      TEXT    NOT NULL REFERENCES customer(customer_id),
  status           TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  verification_ref TEXT    CHECK (verification_ref IS NULL OR length(verification_ref) BETWEEN 1 AND 128),
  verified_at      INTEGER,
  created_at       INTEGER NOT NULL CHECK (created_at > 0),
  -- a decision time exists exactly when a decision was made
  CHECK ((status = 'pending') = (verified_at IS NULL))
) STRICT;

CREATE INDEX kyc_verification_by_customer ON kyc_verification (customer_id, created_at);

CREATE TRIGGER kyc_verification_no_update BEFORE UPDATE ON kyc_verification
BEGIN SELECT RAISE(ABORT, 'KYC history is append-only'); END;

CREATE TRIGGER kyc_verification_no_delete BEFORE DELETE ON kyc_verification
BEGIN SELECT RAISE(ABORT, 'KYC history is append-only'); END;

-- Current KYC status per customer. A customer with no row has not started KYC.
CREATE VIEW customer_current_kyc AS
SELECT customer_id, verification_id, status, verification_ref, verified_at, created_at
FROM (
  SELECT k.*, row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC, rowid DESC) AS rn
  FROM kyc_verification AS k
)
WHERE rn = 1;

-- ---------------------------------------------------------------------------
-- Wallets (wallet ↔ Core Banking account mapping)
-- ---------------------------------------------------------------------------
CREATE TABLE wallet (
  wallet_id        TEXT    PRIMARY KEY CHECK (wallet_id GLOB 'wal_?*' AND length(wallet_id) <= 64),
  customer_id      TEXT    NOT NULL REFERENCES customer(customer_id),
  core_account_ref TEXT    NOT NULL UNIQUE CHECK (length(core_account_ref) BETWEEN 1 AND 64),
  currency         TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status           TEXT    NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  created_at       INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE INDEX wallet_by_customer ON wallet (customer_id);

CREATE TRIGGER wallet_immutable_columns BEFORE UPDATE ON wallet
WHEN NEW.wallet_id IS NOT OLD.wallet_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.core_account_ref IS NOT OLD.core_account_ref
  OR NEW.currency IS NOT OLD.currency
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'wallet owner, account mapping and currency cannot change'); END;

CREATE TRIGGER wallet_closed_is_final BEFORE UPDATE OF status ON wallet
WHEN OLD.status = 'closed' AND NEW.status <> 'closed'
BEGIN SELECT RAISE(ABORT, 'a closed wallet cannot be reopened'); END;

CREATE TRIGGER wallet_no_delete BEFORE DELETE ON wallet
BEGIN SELECT RAISE(ABORT, 'wallets are closed, not deleted'); END;

-- ---------------------------------------------------------------------------
-- Merchants
-- ---------------------------------------------------------------------------
CREATE TABLE merchant (
  merchant_id      TEXT    PRIMARY KEY CHECK (merchant_id GLOB 'mer_?*' AND length(merchant_id) <= 64),
  display_name     TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  qr_identifier    TEXT    NOT NULL UNIQUE CHECK (length(qr_identifier) BETWEEN 8 AND 128),
  core_account_ref TEXT    NOT NULL UNIQUE CHECK (length(core_account_ref) BETWEEN 1 AND 64),
  status           TEXT    NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  created_at       INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TRIGGER merchant_immutable_columns BEFORE UPDATE ON merchant
WHEN NEW.merchant_id IS NOT OLD.merchant_id
  OR NEW.qr_identifier IS NOT OLD.qr_identifier
  OR NEW.core_account_ref IS NOT OLD.core_account_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'merchant id, QR identifier and account mapping cannot change'); END;

CREATE TRIGGER merchant_no_delete BEFORE DELETE ON merchant
BEGIN SELECT RAISE(ABORT, 'merchants are closed, not deleted'); END;

-- ---------------------------------------------------------------------------
-- Ops staff (role source for the Ops Portal; login is a Better Auth user)
-- (deviation from Assignment 5: auth_user_id replaces sso_subject)
-- ---------------------------------------------------------------------------
CREATE TABLE ops_user (
  ops_user_id  TEXT    PRIMARY KEY CHECK (ops_user_id GLOB 'ops_?*' AND length(ops_user_id) <= 64),
  auth_user_id TEXT    NOT NULL UNIQUE REFERENCES "user"(id),
  full_name    TEXT    NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  role         TEXT    NOT NULL CHECK (role IN ('support_readonly')),
  status       TEXT    NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at   INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TRIGGER ops_user_immutable_columns BEFORE UPDATE ON ops_user
WHEN NEW.ops_user_id IS NOT OLD.ops_user_id
  OR NEW.auth_user_id IS NOT OLD.auth_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'ops user id, login and creation time cannot change'); END;

CREATE TRIGGER ops_user_no_delete BEFORE DELETE ON ops_user
BEGIN SELECT RAISE(ABORT, 'ops users are disabled, not deleted'); END;

-- One login is either a customer or a staff member, never both.
CREATE TRIGGER customer_login_not_staff BEFORE INSERT ON customer
WHEN EXISTS (SELECT 1 FROM ops_user WHERE auth_user_id = NEW.auth_user_id)
BEGIN SELECT RAISE(ABORT, 'login already belongs to an ops user'); END;

CREATE TRIGGER ops_user_login_not_customer BEFORE INSERT ON ops_user
WHEN EXISTS (SELECT 1 FROM customer WHERE auth_user_id = NEW.auth_user_id)
BEGIN SELECT RAISE(ABORT, 'login already belongs to a customer'); END;
