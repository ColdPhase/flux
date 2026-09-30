-- Owner-invoked personal assistant runs (#68, decision O-008).
-- One enablement per person: its own consent record, per-run ceiling, daily cap and pause,
-- separate from any #58 background rule. Nothing here stores key material.
CREATE TABLE personal_run_enablements (
  owner_user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  -- The owner's O-007 key connection. It becomes a foreign key to #124's
  -- background_compute_connections(id) when that table lands; until then it is a
  -- snapshot that every dispatch compares with the owner's current connection.
  connection_id uuid,
  consent_version text NOT NULL CHECK (consent_version = 'o-008-2026-09-28'),
  consented_at timestamptz NOT NULL DEFAULT now(),
  consent_provider text NOT NULL CHECK (consent_provider = 'anthropic'),
  consent_model text NOT NULL CHECK (length(consent_model) BETWEEN 1 AND 100),
  consent_payer_organization text NOT NULL CHECK (length(consent_payer_organization) BETWEEN 1 AND 200),
  consent_payer_workspace text NOT NULL CHECK (length(consent_payer_workspace) BETWEEN 1 AND 200),
  per_run_cents integer NOT NULL DEFAULT 6 CHECK (per_run_cents BETWEEN 6 AND 50),
  daily_cap_cents integer NOT NULL DEFAULT 100 CHECK (daily_cap_cents BETWEEN 10 AND 1000),
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The owner's assistant agent in each workspace. Its project grants, capped by the owner's own
-- access, bound what a run may read; `agent.invoke` allows only the owning person.
CREATE TABLE personal_run_agents (
  owner_user_id text NOT NULL REFERENCES personal_run_enablements(owner_user_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, workspace_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE personal_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  -- Snapshot of the connection the run was reserved on; no foreign key until #124 (see above).
  connection_id uuid,
  client_run_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ask', 'summarize', 'map_thought')),
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 4000),
  target_sketch_id uuid,
  target_thought_id uuid,
  continues_run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
  retry_of_run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'reading', 'dispatching', 'completed', 'truncated', 'stopped', 'denied', 'paused',
    'revoked', 'cap_reached', 'unavailable', 'input_too_large', 'provider_failed')),
  stopped_at_stage text CHECK (stopped_at_stage IN ('before_read', 'before_dispatch', 'before_commit')),
  stop_requested_at timestamptz,
  cost_state text NOT NULL DEFAULT 'reserved' CHECK (cost_state IN ('reserved', 'released', 'observed', 'unknown')),
  reserved_micros integer NOT NULL CHECK (reserved_micros > 0),
  charged_micros integer NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  model text NOT NULL,
  -- Written only by the commit that passed the final recheck; a withheld answer is never stored.
  answer_body text CHECK (answer_body IS NULL OR length(answer_body) <= 100000),
  answer_truncated boolean NOT NULL DEFAULT false,
  answer_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, client_run_id),
  UNIQUE (workspace_id, project_id, id),
  CHECK ((target_sketch_id IS NULL) = (target_thought_id IS NULL)),
  CHECK ((answer_body IS NULL) = (committed_at IS NULL)),
  FOREIGN KEY (workspace_id, project_id, conversation_id)
    REFERENCES project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);
-- O-008 §3: at most one personal run in flight per owner.
CREATE UNIQUE INDEX personal_runs_one_in_flight_idx ON personal_runs(owner_user_id)
  WHERE status IN ('queued', 'reading', 'dispatching');
CREATE INDEX personal_runs_owner_idx ON personal_runs(owner_user_id, created_at DESC, id DESC);
CREATE INDEX personal_runs_answers_idx ON personal_runs(conversation_id, committed_at, id)
  WHERE committed_at IS NOT NULL;

-- A consequential change drafted by a personal run. It is not a result until a person with
-- authority accepts it; the accepted result stays attributable to the drafting assistant.
CREATE TABLE assistant_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  fact text NOT NULL CHECK (length(btrim(fact)) BETWEEN 1 AND 2000),
  interpretation text NOT NULL CHECK (length(btrim(interpretation)) BETWEEN 1 AND 2000),
  change_type text NOT NULL CHECK (change_type = 'result'),
  result_title text NOT NULL CHECK (length(btrim(result_title)) BETWEEN 1 AND 200),
  result_finding text NOT NULL CHECK (result_finding IN ('positive', 'negative')),
  result_evidence text NOT NULL DEFAULT '' CHECK (length(result_evidence) <= 20000),
  finishes_work_id uuid,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  decided_by text REFERENCES auth_users(id),
  decided_at timestamptz,
  result_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'accepted') = (result_id IS NOT NULL)),
  CHECK ((status = 'proposed') = (decided_by IS NULL)),
  FOREIGN KEY (workspace_id, project_id, run_id) REFERENCES personal_runs(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, finishes_work_id) REFERENCES project_work_items(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, result_id) REFERENCES project_results(workspace_id, project_id, id)
);
CREATE INDEX assistant_proposals_project_idx ON assistant_proposals(project_id, created_at DESC, id DESC);

INSERT INTO flux_schema_version(version) VALUES (23) ON CONFLICT DO NOTHING;
