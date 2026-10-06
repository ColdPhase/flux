-- Reversal of 0055 (#276). Not applied by the migrator and never edits the schema ledger. The numbers are
-- derived from creation order, so nothing is lost; a later 0055 numbers the tasks again the same way.
DROP TRIGGER project_work_number ON project_work_items;
DROP FUNCTION project_work_number();
DROP INDEX project_work_number_idx;
ALTER TABLE project_work_items DROP COLUMN number;
DROP TRIGGER project_task_sequence_lifecycle ON projects;
DROP FUNCTION project_task_sequence_lifecycle();
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT id FROM projects LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS %I', 'project_task_number_' || replace(p.id::text, '-', ''));
  END LOOP;
END $$;
DROP FUNCTION project_task_sequence(uuid);
