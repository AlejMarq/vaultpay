-- Mock Core Banking DB – schema v2
-- Postings (Step 7): the bank records which VaultPay transfer a posting belongs to and
-- refuses postings that involve an account that is not active. Funds are enforced by
-- account.balance_cents >= 0 (schema v1): a debit below zero aborts the whole transaction.

ALTER TABLE posting ADD COLUMN reference TEXT
  CHECK (reference IS NULL OR (reference GLOB 'trf_?*' AND length(reference) <= 64));
ALTER TABLE posting ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD');

CREATE TRIGGER posting_requires_active_accounts BEFORE INSERT ON posting
WHEN NOT EXISTS (SELECT 1 FROM account WHERE account_ref = NEW.debit_account AND status = 'active')
  OR NOT EXISTS (SELECT 1 FROM account WHERE account_ref = NEW.credit_account AND status = 'active')
BEGIN SELECT RAISE(ABORT, 'postings need two active accounts'); END;
