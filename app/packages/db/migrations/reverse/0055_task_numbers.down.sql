-- Reversal of 0055 (#276). Not applied by the migrator and never edits the schema ledger. The numbers are
-- derived from creation order, so nothing is lost; a later 0055 numbers the tasks again the same way.
-- Search documents of tasks without the number, as 0014 wrote them.
CREATE OR REPLACE FUNCTION search_index_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'work:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('work:' || NEW.id, 'work', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, NULL, NULL,
    CASE WHEN NEW.parked_by_decision_id IS NOT NULL THEN 'parked' ELSE NEW.status END,
    NEW.title, concat_ws(E'\n', nullif(NEW.outcome, ''), NEW.blocker), NEW.created_by_kind, NEW.created_by_id, NEW.updated_at);
  RETURN NEW;
END $$;
DO $$
BEGIN
  PERFORM search_put('work:' || w.id, 'work', w.workspace_id, 'project:' || w.project_id, w.project_id, w.id::text, NULL, NULL,
    CASE WHEN w.parked_by_decision_id IS NOT NULL THEN 'parked' ELSE w.status END,
    w.title, concat_ws(E'\n', nullif(w.outcome, ''), w.blocker), w.created_by_kind, w.created_by_id, w.updated_at)
  FROM project_work_items w;
END $$;
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
