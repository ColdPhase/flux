-- Persist a fail-closed admission fence before deleting a LiveKit room during
-- an access change. A restart can safely retire the old generation and clear it.
ALTER TABLE live_sessions DROP CONSTRAINT live_sessions_state_check;
ALTER TABLE live_sessions ADD CONSTRAINT live_sessions_state_check
  CHECK (state IN ('available', 'rotating', 'ended'));

CREATE TABLE live_access_fences (
  scope_key text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL AND scope_key = 'w:' || workspace_id::text)
    OR (project_id IS NOT NULL AND scope_key = 'p:' || project_id::text))
);
CREATE INDEX live_access_fences_workspace_idx ON live_access_fences(workspace_id);

INSERT INTO flux_schema_version(version) VALUES (17) ON CONFLICT DO NOTHING;
