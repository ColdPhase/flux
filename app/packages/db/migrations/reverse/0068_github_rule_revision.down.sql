-- Guarded pre-use reversal of 0068 (#74). It is not applied by the migrator and never edits the schema ledger.
-- The column only carries a compare-and-set token, so dropping it loses no task or provider data.
ALTER TABLE github_task_rules DROP COLUMN IF EXISTS revision;
