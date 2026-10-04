-- #228 map durability. A preview is expiring transport state, never a native change/event.
CREATE TABLE IF NOT EXISTS map_live_heads (
  sketch_id uuid PRIMARY KEY REFERENCES sketches(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id), generation uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sketch_id,generation),
  FOREIGN KEY(workspace_id,sketch_id) REFERENCES sketches(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS map_live_journal (
  sketch_id uuid NOT NULL REFERENCES sketches(id) ON DELETE CASCADE, generation uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','agent')), actor_id text NOT NULL,
  command_id uuid NOT NULL, fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  change jsonb NOT NULL CHECK (jsonb_typeof(change)='object' AND octet_length(change::text) <= 8388608),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (sketch_id,generation,sequence),
  UNIQUE(actor_kind,actor_id,command_id)
);
CREATE TABLE IF NOT EXISTS map_live_object_versions (
  kind text NOT NULL CHECK (kind IN ('thought','link')), object_id uuid NOT NULL,
  sketch_id uuid NOT NULL REFERENCES sketches(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (kind,object_id)
);
CREATE TABLE IF NOT EXISTS map_live_undone (
  sketch_id uuid NOT NULL, generation uuid NOT NULL, original_sequence bigint NOT NULL,
  inverse_sequence bigint NOT NULL, PRIMARY KEY(sketch_id,generation,original_sequence),
  FOREIGN KEY(sketch_id,generation,original_sequence) REFERENCES map_live_journal(sketch_id,generation,sequence) ON DELETE CASCADE,
  FOREIGN KEY(sketch_id,generation,inverse_sequence) REFERENCES map_live_journal(sketch_id,generation,sequence) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS map_live_gestures (
  lease_id uuid PRIMARY KEY, sketch_id uuid NOT NULL REFERENCES sketches(id) ON DELETE CASCADE,
  generation uuid NOT NULL, gesture_id uuid NOT NULL, actor_id text NOT NULL REFERENCES auth_users(id),
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE, connection_id uuid,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740991),
  thoughts jsonb NOT NULL CHECK (jsonb_typeof(thoughts)='array' AND jsonb_array_length(thoughts) BETWEEN 1 AND 200 AND octet_length(thoughts::text)<=65536),
  positions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(positions)='array' AND jsonb_array_length(positions)<=200 AND octet_length(positions::text)<=65536),
  expires_at timestamptz NOT NULL, UNIQUE(actor_id,session_id,sketch_id,generation,gesture_id),
  FOREIGN KEY(sketch_id,generation) REFERENCES map_live_heads(sketch_id,generation) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS map_live_presence (
  connection_id uuid PRIMARY KEY, sketch_id uuid NOT NULL REFERENCES sketches(id) ON DELETE CASCADE,
  generation uuid NOT NULL, actor_id text NOT NULL REFERENCES auth_users(id),
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  selected jsonb NOT NULL CHECK (jsonb_typeof(selected)='array' AND jsonb_array_length(selected)<=16),
  cursor jsonb CHECK (cursor IS NULL OR jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=256), expires_at timestamptz NOT NULL,
  FOREIGN KEY(sketch_id,generation) REFERENCES map_live_heads(sketch_id,generation) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS map_live_gestures_room ON map_live_gestures(sketch_id,generation,expires_at);
CREATE INDEX IF NOT EXISTS map_live_presence_room ON map_live_presence(sketch_id,generation,expires_at);
DROP TRIGGER IF EXISTS map_live_journal_immutable ON map_live_journal;
CREATE TRIGGER map_live_journal_immutable BEFORE UPDATE ON map_live_journal FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();
DROP TRIGGER IF EXISTS map_live_undone_immutable ON map_live_undone;
CREATE TRIGGER map_live_undone_immutable BEFORE UPDATE ON map_live_undone FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();

-- Identity/ownership survives deletion/restoration; only a strictly higher version may change.
CREATE OR REPLACE FUNCTION guard_map_live_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='map_live_object_versions' THEN
    IF ROW(NEW.kind,NEW.object_id,NEW.sketch_id) IS DISTINCT FROM ROW(OLD.kind,OLD.object_id,OLD.sketch_id) OR NEW.version<=OLD.version THEN
      RAISE EXCEPTION 'immutable map object ownership or non-monotonic version' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='map_live_heads' THEN
    IF ROW(NEW.sketch_id,NEW.workspace_id,NEW.generation) IS DISTINCT FROM ROW(OLD.sketch_id,OLD.workspace_id,OLD.generation) OR NEW.sequence<OLD.sequence THEN
      RAISE EXCEPTION 'immutable map room or non-monotonic sequence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER map_live_object_identity BEFORE UPDATE ON map_live_object_versions FOR EACH ROW EXECUTE FUNCTION guard_map_live_identity();
CREATE TRIGGER map_live_head_identity BEFORE UPDATE ON map_live_heads FOR EACH ROW EXECUTE FUNCTION guard_map_live_identity();
