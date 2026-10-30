-- #479 AC-3/AC-4: the #153 current-recipient bridge (docs/development/github-integration/README.md "#153 current-recipient
-- bridge"). Rows written before this migration stay 'pending_audience_adapter'; new rows record the decision and recipient.
ALTER TABLE github_bridge_outbox DROP CONSTRAINT github_bridge_outbox_state_check;
ALTER TABLE github_bridge_outbox ADD CONSTRAINT github_bridge_outbox_state_check
  CHECK (state IN ('pending_audience_adapter', 'delivered', 'no_recipient', 'no_access', 'suppressed_echo'));
ALTER TABLE github_bridge_outbox ADD COLUMN recipient_connection_id uuid;
ALTER TABLE github_bridge_outbox ADD CONSTRAINT github_bridge_outbox_recipient_check
  CHECK ((state = 'delivered') = (recipient_connection_id IS NOT NULL));
CREATE INDEX github_bridge_outbox_recipient_idx ON github_bridge_outbox (recipient_connection_id, project_id, created_at DESC)
  WHERE recipient_connection_id IS NOT NULL;
