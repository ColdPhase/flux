-- Reversal of 0120 (#469). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- The references and the file details are derived presentation of messages that stay as they are, so dropping them loses no message.
ALTER TABLE project_files DROP COLUMN duration_ms;
ALTER TABLE project_files DROP COLUMN row_count;
ALTER TABLE project_files DROP COLUMN page_count;
DROP TABLE message_references;
