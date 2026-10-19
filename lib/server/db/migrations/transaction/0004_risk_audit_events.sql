-- VaultPay Transaction DB – schema v4
-- Audit event types for fraud screening (Step 6). Append-only like the rest of the list.

INSERT INTO audit_event_type (event_type, description) VALUES
  ('transfer.risk_approved', 'Fraud & Risk Check approved the transfer (signed decision verified); it awaits settlement'),
  ('transfer.risk_declined', 'Fraud & Risk Check declined the transfer (signed decision verified)'),
  ('risk.decision_rejected', 'A fraud decision failed verification or did not match the transfer and was not applied');
