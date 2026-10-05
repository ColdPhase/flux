-- Reversal of 0055 (#276). Not applied by the migrator and never edits the schema ledger. The numbers are
-- derived from creation order, so nothing is lost; a later 0055 numbers the tasks again the same way.
DROP TRIGGER project_work_number ON project_work_items;
DROP FUNCTION project_work_number();
DROP INDEX project_work_number_idx;
ALTER TABLE project_work_items DROP COLUMN number;
ALTER TABLE projects DROP COLUMN task_number_seq;
