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
  UNIQUE (workspace_id, project_id, work_id, run_id, unit_key),
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
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
