-- F-027 A1 / #402: one assistant identity and safety settings per owner/workspace.
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_compute_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client', 'owner_assistant'));
ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_compute_source_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client', 'owner_assistant'));
CREATE UNIQUE INDEX agent_connections_assistant_owner_idx ON agent_connections(workspace_id, owner_user_id)
  WHERE compute_source = 'owner_assistant';
CREATE TABLE assistant_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  connection_id uuid NOT NULL UNIQUE,
  approval_mode text NOT NULL DEFAULT 'act' CHECK (approval_mode IN ('act', 'ask')),
  changes_per_run integer NOT NULL DEFAULT 20 CHECK (changes_per_run BETWEEN 1 AND 100),
  background_runs_per_day integer NOT NULL DEFAULT 10 CHECK (background_runs_per_day BETWEEN 0 AND 100),
  project_mode text NOT NULL DEFAULT 'all' CHECK (project_mode IN ('all', 'chosen')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES agent_connections(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE assistant_join_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES assistant_settings(connection_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
