-- Reversal of 0132 (#479). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Delivered bridge decisions are lost; the rows return to the undelivered state they had before 0132.
DROP INDEX IF EXISTS github_bridge_outbox_recipient_idx;
ALTER TABLE github_bridge_outbox DROP CONSTRAINT IF EXISTS github_bridge_outbox_recipient_check;
ALTER TABLE github_bridge_outbox DROP COLUMN IF EXISTS recipient_connection_id;
UPDATE github_bridge_outbox SET state = 'pending_audience_adapter';
ALTER TABLE github_bridge_outbox DROP CONSTRAINT github_bridge_outbox_state_check;
ALTER TABLE github_bridge_outbox ADD CONSTRAINT github_bridge_outbox_state_check CHECK (state = 'pending_audience_adapter');
