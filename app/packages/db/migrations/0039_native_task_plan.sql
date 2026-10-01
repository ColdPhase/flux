-- #152: native task criteria, same-project prerequisite edges and immutable plan intent.
-- Additive and re-runnable. Every existing task keeps its content, status, authors, versions and times:
-- it gets empty criteria, no edges and no plan intent (absence, never guessed history). Nothing here
-- backfills, moves or rewrites a row, and 0033/0034/0037/0038 stay frozen.
--
-- Edges and intents are written only by the native work command, which first holds the project
-- task-graph advisory lock (hashtextextended('flux.task-graph:' || project_id, 0)), so two writers
-- cannot create the same intent or close a dependency cycle. Cycles are rejected there (a recursive
-- trigger could not see an uncommitted reciprocal edge); the table rules below hold for any writer.

-- Criteria: a bounded JSON array of distinct, already trimmed statements of 1-1000 characters. The
-- application trims with JavaScript whitespace rules; the database accepts exactly those results.
CREATE OR REPLACE FUNCTION flux_task_criteria_valid(criteria jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(criteria) <> 'array' THEN false ELSE
    jsonb_array_length(criteria) <= 20
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(criteria) AS item
      WHERE jsonb_typeof(item) <> 'string'
        OR length(item #>> '{}') NOT BETWEEN 1 AND 1000
        OR (item #>> '{}') <> btrim(item #>> '{}', E' \t\r\n'))
    AND (SELECT count(DISTINCT item) FROM jsonb_array_elements(criteria) AS item) = jsonb_array_length(criteria)
  END
$$;

ALTER TABLE project_work_items ADD COLUMN IF NOT EXISTS criteria jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE project_work_items DROP CONSTRAINT IF EXISTS project_work_criteria_bounded;
ALTER TABLE project_work_items ADD CONSTRAINT project_work_criteria_bounded
  CHECK (flux_task_criteria_valid(criteria));

-- Direct prerequisites: task_id may start only once every prerequisite_id is done (and unparked).
-- Both composite foreign keys keep an edge inside one workspace and project; a task never depends on
-- itself and a pair is stored once. Edges follow their tasks when a project is removed.
CREATE TABLE IF NOT EXISTS project_task_dependencies (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  prerequisite_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, task_id, prerequisite_id),
  CONSTRAINT project_task_dependency_not_self CHECK (task_id <> prerequisite_id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, prerequisite_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_task_dependencies_task_idx
  ON project_task_dependencies(task_id, prerequisite_id);
CREATE INDEX IF NOT EXISTS project_task_dependencies_prerequisite_idx
  ON project_task_dependencies(prerequisite_id, task_id);

-- A task has at most 50 prerequisites. The command validates this first; the trigger keeps any other
-- writer inside the same bound (writers of one project are serialized by the graph lock).
CREATE OR REPLACE FUNCTION flux_task_dependency_bound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM project_task_dependencies WHERE task_id = NEW.task_id) >= 50 THEN
    RAISE EXCEPTION 'a task has at most 50 prerequisites' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_task_dependency_bound ON project_task_dependencies;
CREATE TRIGGER project_task_dependency_bound BEFORE INSERT ON project_task_dependencies
FOR EACH ROW EXECUTE FUNCTION flux_task_dependency_bound();

-- Plan intent: binds one exact, immutable plan revision and a trimmed key to the one task it produced,
-- the normalized creation fingerprint and the task's original version. It is native correlation shared
-- with human creation, not an agent receipt, grant or instruction. A task has at most one intent.
CREATE TABLE IF NOT EXISTS project_task_plan_intents (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  material_id uuid NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  intent_key text NOT NULL,
  task_id uuid NOT NULL UNIQUE,
  creation_fingerprint text NOT NULL CHECK (creation_fingerprint ~ '^[0-9a-f]{64}$'),
  task_version integer NOT NULL CHECK (task_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, material_id, material_version, intent_key),
  CONSTRAINT project_task_plan_intent_key CHECK (length(intent_key) BETWEEN 1 AND 120
    AND intent_key = btrim(intent_key, E' \t\r\n')),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, material_id, material_version)
    REFERENCES project_material_versions(workspace_id, project_id, material_id, version),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES project_work_items(workspace_id, project_id, id)
);

-- An intent is a historical statement, like a material version: it is never rewritten. It leaves only
-- with its project (cascade), so a deleted or edited task stays visible as TASK_INTENT_STALE.
CREATE OR REPLACE FUNCTION flux_task_plan_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task plan intents are immutable' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS project_task_plan_intent_immutable ON project_task_plan_intents;
CREATE TRIGGER project_task_plan_intent_immutable BEFORE UPDATE ON project_task_plan_intents
FOR EACH ROW EXECUTE FUNCTION flux_task_plan_intent_immutable();
