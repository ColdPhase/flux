-- Durable local co-work (#153). Slot/unit/checkpoint storage uses existing identity and
-- native-task keys; #152 owns standing grants/runtime/one command ledger. No model execution.
CREATE TABLE cowork_connection_slots (
  connection_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES agent_connections(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE cowork_units (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  lineage_work_id uuid NOT NULL,
  run_id uuid NOT NULL,
  unit_key text NOT NULL CHECK (length(unit_key) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('execute', 'review', 'plan')),
  assignment_connection_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'paused', 'completed', 'stopped')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  lease_id uuid,
  lease_session_id text,
  lease_expires_at timestamptz,
  checkpoint_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, work_id, id),
  UNIQUE (workspace_id, project_id, work_id, run_id, unit_key),
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, lineage_work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  CHECK ((state = 'claimed' AND generation > 0 AND lease_id IS NOT NULL
    AND lease_session_id IS NOT NULL AND length(lease_session_id) BETWEEN 1 AND 255 AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed' AND lease_id IS NULL AND lease_session_id IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX cowork_units_connection_idx ON cowork_units(assignment_connection_id, state, lease_expires_at);
CREATE INDEX cowork_units_work_idx ON cowork_units(workspace_id, project_id, work_id);

CREATE TABLE cowork_checkpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  runtime_session_id text NOT NULL CHECK (length(runtime_session_id) BETWEEN 1 AND 255),
  generation integer NOT NULL CHECK (generation > 0),
  progress jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, unit_id, id),
  FOREIGN KEY (workspace_id, project_id, unit_id) REFERENCES cowork_units(workspace_id, project_id, id) ON DELETE CASCADE
);
ALTER TABLE cowork_units ADD CONSTRAINT cowork_units_checkpoint_fk
  FOREIGN KEY (workspace_id, project_id, id, checkpoint_id)
  REFERENCES cowork_checkpoints(workspace_id, project_id, unit_id, id);

-- Historical assignment/checkpoint connection IDs intentionally do not reference live
-- credentials. Lifecycle removal must preserve provenance without leaving active leases.
CREATE FUNCTION cowork_stop_connection_units() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  -- The parent connection row is already exclusively locked by UPDATE/DELETE.
  PERFORM connection_id FROM cowork_connection_slots
    WHERE connection_id = OLD.id ORDER BY connection_id FOR UPDATE;
  PERFORM id FROM project_work_items
    WHERE id IN (SELECT work_id FROM cowork_units WHERE assignment_connection_id = OLD.id
      AND state NOT IN ('completed', 'stopped')) ORDER BY id FOR UPDATE;
  PERFORM id FROM cowork_units WHERE assignment_connection_id = OLD.id
    AND state NOT IN ('completed', 'stopped') ORDER BY id FOR UPDATE;
  UPDATE cowork_units SET state = 'stopped', generation = generation + 1, version = version + 1,
    lease_id = NULL, lease_session_id = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE assignment_connection_id = OLD.id AND state NOT IN ('completed', 'stopped');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cowork_connection_revoked BEFORE UPDATE OF revoked_at ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION cowork_stop_connection_units();
CREATE TRIGGER cowork_connection_deleted BEFORE DELETE ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION cowork_stop_connection_units();

-- Control metadata only: no copied source contents and no separate command/grant ledger.
CREATE TABLE cowork_request_lineages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  root_work_id uuid NOT NULL,
  run_id uuid NOT NULL,
  maximum_requests integer NOT NULL CHECK (maximum_requests BETWEEN 1 AND 128),
  maximum_depth integer NOT NULL CHECK (maximum_depth BETWEEN 0 AND 8),
  maximum_review_rounds integer NOT NULL CHECK (maximum_review_rounds BETWEEN 0 AND 16),
  created_requests integer NOT NULL DEFAULT 0 CHECK (created_requests BETWEEN 0 AND maximum_requests),
  review_requests integer NOT NULL DEFAULT 0 CHECK (review_requests BETWEEN 0 AND maximum_review_rounds),
  UNIQUE (workspace_id, project_id, root_work_id, run_id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, root_work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE TABLE cowork_requests (
  id uuid PRIMARY KEY,
  lineage_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  sender_connection_id uuid NOT NULL,
  recipient_connection_id uuid NOT NULL,
  sender_owner_id text NOT NULL,
  recipient_owner_id text NOT NULL,
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  parent_request_id uuid,
  kind text NOT NULL CHECK (kind IN ('help', 'review', 'fix', 'handoff')),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 1024),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 16 AND octet_length(source_refs::text) <= 16384),
  criteria_refs jsonb NOT NULL CHECK (jsonb_typeof(criteria_refs) = 'array' AND jsonb_array_length(criteria_refs) BETWEEN 1 AND 8 AND octet_length(criteria_refs::text) <= 8192),
  depth integer NOT NULL CHECK (depth BETWEEN 0 AND 8),
  review_round integer NOT NULL CHECK (review_round BETWEEN 0 AND 16),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 3),
  peer_unblocking boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'deferred', 'claimed', 'resolved', 'declined', 'superseded', 'expired', 'cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text,
  next_boundary text,
  dependency_ref jsonb,
  claimed_generation integer,
  response_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lineage_id, intent_key),
  UNIQUE (lineage_id, id),
  FOREIGN KEY (workspace_id, project_id, lineage_id) REFERENCES cowork_request_lineages(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, work_id, unit_id) REFERENCES cowork_units(workspace_id, project_id, work_id, id) ON DELETE CASCADE,
  FOREIGN KEY (lineage_id, parent_request_id) REFERENCES cowork_requests(lineage_id, id),
  CHECK ((parent_request_id IS NULL AND depth = 0) OR (parent_request_id IS NOT NULL AND depth > 0)),
  CHECK (state <> 'deferred' OR (reason IS NOT NULL AND next_boundary IS NOT NULL)),
  CHECK (state <> 'deferred' OR reason <> 'dependency' OR (dependency_ref IS NOT NULL AND jsonb_typeof(dependency_ref) = 'object')),
  CHECK (state <> 'claimed' OR (claimed_generation IS NOT NULL AND claimed_generation > 0)),
  CHECK (state <> 'resolved' OR (response_ref IS NOT NULL AND jsonb_typeof(response_ref) = 'object')),
  CHECK (state NOT IN ('declined', 'superseded', 'expired', 'cancelled') OR reason IS NOT NULL)
);
CREATE INDEX cowork_requests_recipient_idx ON cowork_requests(workspace_id, project_id, recipient_connection_id, created_at, id);
CREATE TABLE cowork_delivery_intents (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES cowork_requests(id) ON DELETE CASCADE,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
