-- VaultPay Transaction DB – schema v2
-- Audit event types (D18: the format-only check from v1 is replaced by an explicit list).
--
-- Every audit_event must use a registered type. Later steps register their own types in
-- new migrations; the list itself is append-only.

CREATE TABLE audit_event_type (
  event_type  TEXT PRIMARY KEY CHECK (length(event_type) BETWEEN 1 AND 64 AND event_type NOT GLOB '*[^a-z0-9_.]*'),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200)
) STRICT;

CREATE TRIGGER audit_event_type_no_update BEFORE UPDATE ON audit_event_type
BEGIN SELECT RAISE(ABORT, 'audit event types are append-only'); END;

CREATE TRIGGER audit_event_type_no_delete BEFORE DELETE ON audit_event_type
BEGIN SELECT RAISE(ABORT, 'audit event types are append-only'); END;

INSERT INTO audit_event_type (event_type, description) VALUES
  ('support.customer_search', 'An ops user searched for a customer by email'),
  ('support.customer_view', 'An ops user viewed a customer''s account, wallet, KYC status and transfers');

CREATE TRIGGER audit_event_registered_type BEFORE INSERT ON audit_event
WHEN NOT EXISTS (SELECT 1 FROM audit_event_type WHERE event_type = NEW.event_type)
BEGIN SELECT RAISE(ABORT, 'unknown audit event type'); END;
