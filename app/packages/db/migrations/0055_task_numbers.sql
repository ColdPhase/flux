-- #276 (F-023 FF-1): each project numbers its tasks 1, 2, 3, … in creation order, shown as "#12". A number is
-- never reused or changed. The project row keeps the last number given out; a trigger takes the next one under
-- that row's lock, so concurrent creations in one project get distinct numbers on every insert path. An insert
-- skipped by an idempotent retry may leave a gap, which is fine: numbers name tasks, they do not count them.
-- 0052–0054 are reserved by open branches (#270, #275, #261).
ALTER TABLE projects ADD COLUMN task_number_seq integer NOT NULL DEFAULT 0;
ALTER TABLE project_work_items ADD COLUMN number integer;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n FROM project_work_items
)
UPDATE project_work_items w SET number = numbered.n FROM numbered WHERE w.id = numbered.id;
UPDATE projects p SET task_number_seq = coalesce((SELECT max(w.number) FROM project_work_items w WHERE w.project_id = p.id), 0);

CREATE FUNCTION project_work_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'a task number never changes' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE projects SET task_number_seq = task_number_seq + 1 WHERE id = NEW.project_id RETURNING task_number_seq INTO NEW.number;
  IF NEW.number IS NULL THEN
    RAISE EXCEPTION 'no project % for a task number', NEW.project_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_work_number BEFORE INSERT OR UPDATE OF number ON project_work_items
  FOR EACH ROW EXECUTE FUNCTION project_work_number();

ALTER TABLE project_work_items ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX project_work_number_idx ON project_work_items(project_id, number);
