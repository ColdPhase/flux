-- #160 AC-1: a client records the exact Flux co-work playbook it loaded for one server-issued runtime session.
-- Compatibility evidence only: it grants nothing, changes no authority and does not prove that a model follows
-- the playbook. Additive; no existing row changes. Sparse after 0039 (0040 is #154's), independent of it.
CREATE TABLE agent_playbook_acknowledgments (
  runtime_session_id uuid PRIMARY KEY REFERENCES agent_runtime_sessions(id) ON DELETE CASCADE,
  bundle_id text NOT NULL CHECK (bundle_id ~ '^[a-z][a-z0-9.-]{0,63}$'),
  version text NOT NULL CHECK (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);
