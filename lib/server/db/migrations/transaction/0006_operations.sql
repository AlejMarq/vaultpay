-- VaultPay Transaction DB – schema v6
-- Operations, reconciliation and recovery (Step 8): audit event types only. The
-- reconciliation_result table (schema v1) records every reconciliation decision; audit
-- events and results stay append-only.

INSERT INTO audit_event_type (event_type, description) VALUES
  ('transfer.reconciled', 'Reconciliation found the original bank posting; transfer completed and ledger written'),
  ('transfer.reconciled_not_posted', 'Reconciliation found no bank posting for the attempt key; transfer failed, nothing moved'),
  ('reconciliation.mismatch', 'The bank holds a posting for the attempt key whose details differ; left unresolved for investigation'),
  ('reconciliation.unresolved', 'The bank outcome could not be determined (outage or invalid answer); left unresolved and retried later'),
  ('transfer.expired', 'A pending transfer passed its deadline before any settlement request; reserved funds released'),
  ('outbox.requeued', 'A parked outbox message was replaced by a new one for an operator-requested retry'),
  ('ledger.integrity_mismatch', 'The ledger integrity check found an inconsistency; flagged, not corrected'),
  ('support.operations_view', 'A support user viewed the read-only operations overview');
