-- Person-owned MCP agent proposals. A proposal is not a published material.
CREATE TABLE agent_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  compute_source text NOT NULL CHECK (compute_source = 'user_operated_claude_code'),
  agent_grant_id uuid NOT NULL,
  agent_grant_role text NOT NULL CHECK (agent_grant_role = 'contributor'),
  source_material_id uuid NOT NULL,
  source_material_version integer NOT NULL CHECK (source_material_version > 0),
  client_command_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  fact text NOT NULL CHECK (length(btrim(fact)) BETWEEN 1 AND 10000),
  interpretation text NOT NULL CHECK (length(btrim(interpretation)) BETWEEN 1 AND 10000),
  suggested_action text NOT NULL CHECK (length(btrim(suggested_action)) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'dismissed')),
  dismissed_by text REFERENCES auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, project_id, client_command_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, source_material_id, source_material_version)
    REFERENCES project_material_versions(workspace_id, project_id, material_id, version)
);
CREATE INDEX agent_proposals_project_idx ON agent_proposals(project_id, created_at DESC, id DESC);

INSERT INTO flux_schema_version(version) VALUES (7) ON CONFLICT DO NOTHING;
