-- Reversal of 0108 (#488). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- It forgets every task's due date and the activity of status, owner, due date and title changes.
DROP TABLE project_task_activity;
ALTER TABLE project_work_items DROP COLUMN due_on;
