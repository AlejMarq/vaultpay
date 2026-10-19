-- VaultPay Transaction DB – schema v5
-- Settlement and the double-entry ledger (Step 7).

-- Each posting links to the bank's posting reference (settlement_attempt.core_banking_ref).
ALTER TABLE ledger_entry ADD COLUMN core_banking_ref TEXT
  CHECK (core_banking_ref IS NULL OR length(core_banking_ref) BETWEEN 1 AND 128);

-- A new (non-reversal) posting must carry the bank reference of its transfer's settled attempt.
CREATE TRIGGER ledger_posting_has_bank_ref BEFORE INSERT ON ledger_entry
WHEN NEW.reverses_entry_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM settlement_attempt AS a
  WHERE a.transfer_id = NEW.transfer_id AND a.outcome = 'settled' AND a.core_banking_ref = NEW.core_banking_ref
)
BEGIN SELECT RAISE(ABORT, 'ledger posting must reference the settled bank posting of its transfer'); END;

-- Double entry: a credit is written only after the matching debit of the same posting.
CREATE TRIGGER ledger_credit_follows_debit BEFORE INSERT ON ledger_entry
WHEN NEW.reverses_entry_id IS NULL AND NEW.direction = 'credit' AND NOT EXISTS (
  SELECT 1 FROM ledger_entry AS d
  WHERE d.transfer_id = NEW.transfer_id AND d.direction = 'debit' AND d.reverses_entry_id IS NULL
    AND d.amount_cents = NEW.amount_cents AND d.core_banking_ref IS NEW.core_banking_ref
)
BEGIN SELECT RAISE(ABORT, 'a ledger credit needs the matching debit first'); END;

-- Completed only with a settled bank posting; failed only with a definitive bank refusal.
CREATE TRIGGER transfer_completed_requires_settlement BEFORE UPDATE OF status ON transfer
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND NOT EXISTS (
  SELECT 1 FROM settlement_attempt AS a WHERE a.transfer_id = NEW.transfer_id AND a.outcome = 'settled' AND a.core_banking_ref IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'a transfer is completed only after a settled bank posting'); END;

CREATE TRIGGER transfer_failed_requires_refusal BEFORE UPDATE OF status ON transfer
WHEN NEW.status = 'failed' AND OLD.status <> 'failed' AND (
  NOT EXISTS (SELECT 1 FROM settlement_attempt AS a WHERE a.transfer_id = NEW.transfer_id AND a.outcome = 'failed')
  OR EXISTS (SELECT 1 FROM settlement_attempt AS a WHERE a.transfer_id = NEW.transfer_id AND a.outcome IN ('settled', 'pending', 'unknown'))
)
BEGIN SELECT RAISE(ABORT, 'a transfer fails only after a definitive refusal and with no open or settled attempt'); END;

-- The settlement outbox message of a completed transfer can be finished only once its
-- ledger holds exactly one debit and one credit (written in the same transaction).
CREATE TRIGGER outbox_settlement_done_requires_ledger BEFORE UPDATE OF status ON outbox_message
WHEN NEW.status = 'done' AND OLD.target = 'settlement'
  AND EXISTS (SELECT 1 FROM transfer AS t WHERE t.transfer_id = OLD.transfer_id AND t.status = 'completed')
  AND ((SELECT count(*) FROM ledger_entry AS e WHERE e.transfer_id = OLD.transfer_id AND e.reverses_entry_id IS NULL AND e.direction = 'debit') <> 1
    OR (SELECT count(*) FROM ledger_entry AS e WHERE e.transfer_id = OLD.transfer_id AND e.reverses_entry_id IS NULL AND e.direction = 'credit') <> 1)
BEGIN SELECT RAISE(ABORT, 'a completed transfer needs one balanced debit and credit before its settlement message is done'); END;

-- Ledger totals: debits must always equal credits (checked by tests and reconciliation).
CREATE VIEW ledger_totals AS
SELECT coalesce(sum(CASE WHEN direction = 'debit' THEN amount_cents END), 0) AS debit_cents,
       coalesce(sum(CASE WHEN direction = 'credit' THEN amount_cents END), 0) AS credit_cents,
       count(*) AS entries
FROM ledger_entry;

INSERT INTO audit_event_type (event_type, description) VALUES
  ('transfer.settlement_started', 'Settlement attempt recorded before the bank request was sent'),
  ('transfer.settled', 'Core Banking confirmed the posting; ledger written; transfer completed'),
  ('transfer.settlement_failed', 'Core Banking definitively refused the posting; no money moved'),
  ('transfer.settlement_unknown', 'The bank outcome is unknown (timeout or outage); retried with the same idempotency key'),
  ('transfer.risk_rescreen', 'The fraud approval expired before settlement; the transfer returned to screening');
