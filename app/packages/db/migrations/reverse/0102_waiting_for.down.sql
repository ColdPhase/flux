-- Reversal of 0102 (#550). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. It forgets who blocked tasks waited for and the blocked/unblocked lines.
DROP TABLE project_task_updates;
DROP INDEX project_work_items_waiting_for_idx;
ALTER TABLE project_work_items DROP COLUMN waiting_for_user_id;
