-- Reversal of 0129 (#68). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- A removed message keeps its marker text; only the moment it was removed is lost.
ALTER TABLE project_messages DROP COLUMN removed_at;
