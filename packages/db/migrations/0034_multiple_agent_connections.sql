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
CREATE TABLE agent_oauth_bindings (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  connection_id uuid NOT NULL REFERENCES agent_connections(id),
  client_id text NOT NULL REFERENCES oauth_client(client_id),
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
INSERT INTO flux_schema_version(version) VALUES (34) ON CONFLICT DO NOTHING;
