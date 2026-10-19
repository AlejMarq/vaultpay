-- VaultPay Customer & Identity DB – schema v2
-- TOTP replay defense (Step 3, Section 3D).
--
-- Better Auth 1.7.10 accepts the same TOTP code again for a separate sign-in challenge
-- inside its validity window (verified 2026-10-19). VaultPay claims every TOTP code here
-- BEFORE Better Auth checks it: the primary key makes the claim atomic, so a code can
-- complete at most one verification, even under concurrent attempts. Only a SHA-256 of
-- (user, code) is stored, and rows older than the validity window are deleted.

CREATE TABLE totp_code_use (
  user_id    TEXT    NOT NULL REFERENCES "user"(id),
  code_hash  TEXT    NOT NULL CHECK (length(code_hash) = 64),
  claimed_at INTEGER NOT NULL CHECK (claimed_at > 0),
  PRIMARY KEY (user_id, code_hash)
) STRICT, WITHOUT ROWID;

CREATE INDEX totp_code_use_by_time ON totp_code_use (claimed_at);

-- A claim is never edited; it is only released (rejected code) or purged (expired).
CREATE TRIGGER totp_code_use_no_update BEFORE UPDATE ON totp_code_use
BEGIN SELECT RAISE(ABORT, 'TOTP code claims cannot be changed'); END;
