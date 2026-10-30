-- #160 AC-5: a person pauses an external agent's work on a task it holds (docs/product/mcp-cowork.md "Pause and
-- Resume"). One row per (task, agent) while the pause is in force; Resume deletes it. Additive: no existing row changes.
-- Sparse after 0129 (0130 belongs to other open work).
CREATE TABLE agent_pauses (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  paused_by text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, agent_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_pauses_project_idx ON agent_pauses (project_id, paused_at DESC);
