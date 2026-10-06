-- #276 (F-023 FF-1): each project numbers its tasks 1, 2, 3, … in creation order, shown as "#12". A number is
-- never reused or changed. Each project has its own sequence, so numbering takes no row lock and never waits:
-- creating tasks keeps the existing lock order (a counter on the project row deadlocked against writers that
-- hold the project FOR SHARE). A rolled-back or idempotently skipped insert may leave a gap, which is fine:
-- numbers name tasks, they do not count them. 0052–0054 are reserved by open branches (#270, #275, #261).
CREATE FUNCTION project_task_sequence(project uuid) RETURNS regclass LANGUAGE sql STABLE AS $$
  SELECT to_regclass('project_task_number_' || replace(project::text, '-', ''))
$$;

CREATE FUNCTION project_task_sequence_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format('CREATE SEQUENCE %I AS integer', 'project_task_number_' || replace(NEW.id::text, '-', ''));
  ELSE
    EXECUTE format('DROP SEQUENCE IF EXISTS %I', 'project_task_number_' || replace(OLD.id::text, '-', ''));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER project_task_sequence_lifecycle AFTER INSERT OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION project_task_sequence_lifecycle();

ALTER TABLE project_work_items ADD COLUMN number integer;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n FROM project_work_items
)
UPDATE project_work_items w SET number = numbered.n FROM numbered WHERE w.id = numbered.id;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT id, (SELECT max(w.number) FROM project_work_items w WHERE w.project_id = projects.id) AS last FROM projects LOOP
    EXECUTE format('CREATE SEQUENCE %I AS integer', 'project_task_number_' || replace(p.id::text, '-', ''));
    IF p.last IS NOT NULL THEN PERFORM setval(project_task_sequence(p.id), p.last, true); END IF;
  END LOOP;
END $$;

CREATE FUNCTION project_work_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sequence regclass;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'a task number never changes' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  sequence := project_task_sequence(NEW.project_id);
  IF sequence IS NULL THEN
    RAISE EXCEPTION 'no task numbering for project %', NEW.project_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.number := nextval(sequence);
  RETURN NEW;
END $$;
CREATE TRIGGER project_work_number BEFORE INSERT OR UPDATE OF number ON project_work_items
  FOR EACH ROW EXECUTE FUNCTION project_work_number();

ALTER TABLE project_work_items ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX project_work_number_idx ON project_work_items(project_id, number);
