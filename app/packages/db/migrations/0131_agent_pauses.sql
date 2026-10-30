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
-- A pause holds only while its agent holds the task: when the task is finished, dropped, parked or handed to anyone
-- else, the pause row goes in the same statement (#751 review). A later hold starts unpaused.
CREATE FUNCTION flux_agent_pause_follows_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM agent_pauses p WHERE p.task_id = NEW.id
    AND (NEW.owner_agent_id IS DISTINCT FROM p.agent_id OR NEW.status IN ('done', 'not_pursued') OR NEW.parked_at IS NOT NULL);
  RETURN NULL;
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_agent_pause_follows_hold() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER agent_pause_follows_hold AFTER UPDATE OF owner_agent_id, status, parked_at ON project_work_items
  FOR EACH ROW EXECUTE FUNCTION flux_agent_pause_follows_hold();
