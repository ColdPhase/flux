-- Reversal of 0057 (#350). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. The morning summary choice is lost; nothing else changes.
DROP INDEX IF EXISTS notification_preferences_summary_idx;
ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS summary_last_on,
  DROP COLUMN IF EXISTS summary_at,
  DROP COLUMN IF EXISTS summary_enabled;
