-- VaultPay Transaction DB – schema v3
-- Audit event types for transfer initiation (Step 5). Append-only like the rest of the
-- list; audit_event itself stays append-only and accepts only registered types.

INSERT INTO audit_event_type (event_type, description) VALUES
  ('transfer.requested', 'A customer submitted a transfer; it is pending fraud screening and settlement');
