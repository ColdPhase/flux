-- #316, namespace reserved on #153 before this file: restrictive personal MCP policy.
-- Original connection scopes/project consent and OAuth bindings are never rewritten.
-- Explicit application initialization captures the real registration manifest once;
-- absence of a policy is not an implicit allow-all grant.
CREATE TABLE agent_connection_mcp_policies (
  connection_id uuid PRIMARY KEY REFERENCES agent_connections(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CONSTRAINT agent_connection_mcp_policy_version_check CHECK (version > 0),
  enabled_capability_ids text[] NOT NULL,
  enabled_entry_ids text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_connection_mcp_capability_array_check CHECK (
    cardinality(enabled_capability_ids) <= 128 AND array_position(enabled_capability_ids, NULL) IS NULL),
  CONSTRAINT agent_connection_mcp_entry_array_check CHECK (
    cardinality(enabled_entry_ids) <= 256 AND array_position(enabled_entry_ids, NULL) IS NULL)
);
CREATE TABLE agent_connection_mcp_projects (
  connection_id uuid NOT NULL REFERENCES agent_connection_mcp_policies(connection_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  PRIMARY KEY (connection_id, project_id),
  FOREIGN KEY (workspace_id, connection_id, project_id)
    REFERENCES agent_connection_projects(workspace_id, connection_id, project_id) ON DELETE CASCADE
);
