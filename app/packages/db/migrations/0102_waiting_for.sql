-- 0102 (0100 and 0101 are reserved by #560 and #565, which merge first).
-- Blocked tasks can name who they wait for (#550, founder direction 2026-10-16): one person, optional,
-- only while the task is blocked (the application clears it when the task leaves Blocked). No task
-- waits for anyone yet: no backfill.
ALTER TABLE project_work_items ADD COLUMN waiting_for_user_id text REFERENCES auth_users(id) ON DELETE SET NULL;
CREATE INDEX project_work_items_waiting_for_idx ON project_work_items(workspace_id, waiting_for_user_id) WHERE waiting_for_user_id IS NOT NULL;

-- One short line in the project conversation when a task becomes blocked or unblocked. Edits to the
-- reason alone add none. `waiting_for_user_id` and `reason` are what the line said at that moment.
CREATE TABLE project_task_updates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('task.blocked', 'task.unblocked')),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('human', 'agent')),
  created_by_id text NOT NULL,
  waiting_for_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX project_task_updates_project_idx ON project_task_updates(project_id, created_at DESC, id DESC);
