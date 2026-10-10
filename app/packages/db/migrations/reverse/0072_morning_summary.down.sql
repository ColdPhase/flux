ALTER TABLE notifications DROP CONSTRAINT notifications_summary_sources_check;
-- A summary cannot become a legacy no-reason push on reversal.
DELETE FROM notifications WHERE delivery_kind = 'morning_summary';
ALTER TABLE notifications DROP COLUMN summary_sources, DROP COLUMN delivery_kind;

-- Reversal of 0072 (#350). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. The morning summary choice and derived summary records are lost; ordinary notifications remain.
DROP INDEX IF EXISTS notification_preferences_summary_idx;
ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS summary_last_on,
  DROP COLUMN IF EXISTS summary_at,
  DROP COLUMN IF EXISTS summary_enabled;
