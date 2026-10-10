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
  changes_per_run integer NOT NULL DEFAULT 20 CHECK (changes_per_run BETWEEN 1 AND 20),
  background_runs_per_day integer NOT NULL DEFAULT 24 CHECK (background_runs_per_day BETWEEN 0 AND 24),
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

-- Existing enablements receive identity metadata without a new grant or edit capability. Their
-- explicit project grants remain their original ceiling; the owner may later allow editing.
INSERT INTO agent_connections (id, workspace_id, owner_user_id, agent_id, name, client_designation, compute_source, scopes)
SELECT gen_random_uuid(), p.workspace_id, p.owner_user_id, p.agent_id, 'Your assistant', 'other', 'owner_assistant',
  ARRAY['flux.context.read', 'flux.proposal.write', 'flux.action.execute']::text[]
FROM personal_run_agents p JOIN personal_run_enablements e ON e.owner_user_id = p.owner_user_id
JOIN agents a ON a.id = p.agent_id AND a.workspace_id = p.workspace_id AND a.owner_user_id = p.owner_user_id
WHERE a.revoked_at IS NULL;
INSERT INTO assistant_settings (workspace_id, owner_user_id, agent_id, connection_id)
SELECT workspace_id, owner_user_id, agent_id, id FROM agent_connections WHERE compute_source = 'owner_assistant';
INSERT INTO agent_connection_projects (workspace_id, connection_id, project_id)
SELECT c.workspace_id, c.id, g.project_id FROM agent_connections c
JOIN project_grants g ON g.agent_id = c.agent_id AND g.workspace_id = c.workspace_id AND g.role IN ('viewer', 'contributor')
WHERE c.compute_source = 'owner_assistant';
INSERT INTO agent_connection_mcp_policies (connection_id, enabled_capability_ids, enabled_entry_ids)
SELECT id,
  ARRAY['project.identity.read','project.policy.read','project.work.read','project.results.read','project.knowledge.read','project.maps.read','project.conversations.read','project.decisions.read']::text[],
  ARRAY['tool:flux_list_contexts','tool:flux_list_materials','tool:flux_read_material','tool:flux_list_docs','tool:flux_get_doc',
    'tool:flux_list_work','tool:flux_get_work','tool:flux_list_decisions','tool:flux_get_decision','tool:flux_list_results','tool:flux_get_result',
    'tool:flux_list_conversations','tool:flux_get_conversation','tool:flux_list_maps','tool:flux_get_map',
    'tool:flux_search_project','tool:flux_project_orientation','tool:flux_changes_since','resource:flux_project_policy']::text[]
FROM agent_connections WHERE compute_source = 'owner_assistant';
INSERT INTO agent_connection_mcp_projects (workspace_id, connection_id, project_id)
SELECT s.workspace_id, s.connection_id, s.project_id FROM agent_connection_projects s JOIN agent_connections c ON c.id = s.connection_id
WHERE c.compute_source = 'owner_assistant';
