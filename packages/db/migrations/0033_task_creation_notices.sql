-- #154: creation activity has its own durable identity. Do not backfill old tasks
-- or infer/move/rewrite their conversation roots, authors, sources or timestamps.
ALTER TABLE project_work_items ADD COLUMN client_command_id uuid;
ALTER TABLE project_work_items ADD COLUMN request_fingerprint text;
ALTER TABLE project_work_items ADD CONSTRAINT project_work_command_pair
  CHECK ((client_command_id IS NULL) = (request_fingerprint IS NULL));
CREATE UNIQUE INDEX project_work_creation_command_idx
  ON project_work_items(project_id, created_by_kind, created_by_id, client_command_id)
  WHERE client_command_id IS NOT NULL;

CREATE TABLE project_task_notices (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'task.created'),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('human', 'agent')),
  created_by_id text NOT NULL,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  created_at timestamptz NOT NULL,
  UNIQUE (work_id, kind),
  FOREIGN KEY (workspace_id, project_id, work_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX project_task_notices_project_idx
  ON project_task_notices(project_id, created_at DESC, id DESC);
