-- #152: preserve existing rows/proposal provenance; browser choices do not authorize new flows.
ALTER TABLE agent_connections ADD COLUMN name text NOT NULL DEFAULT 'External connection'
  CHECK (length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE agent_connections ADD COLUMN client_designation text NOT NULL DEFAULT 'claude_code'
  CHECK (client_designation IN ('claude_code', 'codex', 'other'));
ALTER TABLE agent_connections ADD COLUMN compute_source text NOT NULL DEFAULT 'user_operated_claude_code'
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
ALTER TABLE agent_connections ALTER COLUMN client_designation SET DEFAULT 'other';
ALTER TABLE agent_connections ALTER COLUMN compute_source SET DEFAULT 'user_operated_external_client';
ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_compute_source_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
-- Existing scope arrays are preserved; execution requires a new explicit selection.
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_scopes_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 3
  AND scopes <@ ARRAY['flux.context.read', 'flux.proposal.write', 'flux.action.execute']::text[]
);
CREATE TABLE agent_oauth_bindings (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  connection_id uuid NOT NULL REFERENCES agent_connections(id),
  client_id text NOT NULL REFERENCES oauth_client(client_id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, connection_id, client_id)
);
CREATE TABLE agent_oauth_flows (
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  binding_id uuid NOT NULL REFERENCES agent_oauth_bindings(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id, session_id, fingerprint)
);
CREATE INDEX agent_oauth_flows_expiry_idx ON agent_oauth_flows(expires_at);


-- Standing/runtime authority is additive; no existing connection receives an execution grant.
ALTER TABLE agent_connection_projects ADD UNIQUE (workspace_id, connection_id, project_id);
CREATE TABLE agent_runtime_sessions (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES agent_oauth_bindings(id),
  binding_generation integer NOT NULL CHECK (binding_generation > 0),
  client_session_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  agent_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3 AND
    scopes <@ ARRAY['flux.context.read', 'flux.proposal.write', 'flux.action.execute']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (binding_id, client_session_id),
  UNIQUE (connection_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES agent_connections(workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id)
);
CREATE INDEX agent_runtime_sessions_connection_idx ON agent_runtime_sessions(connection_id, expires_at);
CREATE TABLE agent_standing_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  client_command_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  operation text NOT NULL CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','cowork.claim','cowork.renew','cowork.release')),
  peer_request_class text NOT NULL CHECK (peer_request_class IN ('execute','review','plan')),
  object_id uuid,
  maximum_uses integer NOT NULL CHECK (maximum_uses BETWEEN 1 AND 1000),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= maximum_uses),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, id),
  UNIQUE (connection_id, client_command_id),
  FOREIGN KEY (workspace_id, connection_id, project_id)
    REFERENCES agent_connection_projects(workspace_id, connection_id, project_id)
);
CREATE INDEX agent_standing_grants_connection_idx ON agent_standing_grants(connection_id, project_id, id);
CREATE TABLE agent_command_receipts (
  connection_id uuid NOT NULL,
  client_command_id uuid NOT NULL,
  runtime_session_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  grant_generation integer NOT NULL CHECK (grant_generation > 0),
  binding_id uuid NOT NULL REFERENCES agent_oauth_bindings(id),
  binding_generation integer NOT NULL CHECK (binding_generation > 0),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  operation text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  value jsonb NOT NULL,
  postconditions jsonb NOT NULL CHECK (jsonb_typeof(postconditions) = 'array'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, client_command_id),
  FOREIGN KEY (connection_id, runtime_session_id) REFERENCES agent_runtime_sessions(connection_id, id),
  FOREIGN KEY (connection_id, grant_id) REFERENCES agent_standing_grants(connection_id, id)
);
INSERT INTO flux_schema_version(version) VALUES (34) ON CONFLICT DO NOTHING;
