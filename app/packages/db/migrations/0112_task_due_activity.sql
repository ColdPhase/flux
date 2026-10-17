-- 0112 (#488, the task panel of Prostota): a task can have a due date, and every change of its status, owner, due date or
-- title is kept as one row of its activity with the real person or agent who made it and when.
-- The due date is a calendar date: no time zone and no time. Existing tasks have none; no backfill. Existing tasks also
-- have no activity before this migration: their creation is derived from created_by/created_at, and nothing is guessed.
ALTER TABLE project_work_items ADD COLUMN due_on date
  CONSTRAINT project_work_items_due_on_range CHECK (due_on IS NULL OR (due_on >= DATE '1970-01-01' AND due_on <= DATE '9999-12-31'));

-- One row per changed field. `detail` holds what the reader of the task sees:
--   status: { from, to, blocker, waitingForUserId }  (blocker and person only when `to` is blocked)
--   owner:  { from, to }  each { kind, id } or null for nobody
--   due:    { from, to }  each YYYY-MM-DD or null
--   title:  { from, to }
-- It never references auth_users: a closed account leaves the row, and the reader shows a former member. The rows follow
-- their task, and their task follows the project, so a project erases in one delete (#551).
CREATE TABLE project_task_activity (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('status', 'owner', 'due', 'title')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  actor_id text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX project_task_activity_work_idx ON project_task_activity(work_id, created_at DESC, id DESC);
