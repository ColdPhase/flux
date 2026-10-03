-- #228 disabled-development persistence foundation. No room or event is backfilled.
-- Current material/access locks precede the live-head lock. A clean native write
-- retires the generation; a deliberate shared snapshot only advances its saved binding.
CREATE TABLE IF NOT EXISTS doc_live_heads (
  doc_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  generation uuid NOT NULL, sequence bigint NOT NULL DEFAULT 0,
  body text NOT NULL, hash text NOT NULL, saved_version integer NOT NULL,
  saved_sequence bigint NOT NULL DEFAULT 0, codec_state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,project_id,doc_id) REFERENCES project_materials(workspace_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,project_id,doc_id,saved_version) REFERENCES project_material_versions(workspace_id,project_id,material_id,version),
  CONSTRAINT doc_live_head_sequence CHECK (sequence BETWEEN 0 AND 9007199254740991 AND saved_sequence BETWEEN 0 AND sequence),
  CONSTRAINT doc_live_head_hash CHECK (hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT doc_live_head_body CHECK (char_length(body) <= 100000),
  CONSTRAINT doc_live_head_codec_bytes CHECK (codec_state IS NULL OR octet_length(codec_state::text) <= 8388608)
);
CREATE TABLE IF NOT EXISTS doc_live_archives (
  doc_id uuid NOT NULL REFERENCES project_materials(id) ON DELETE CASCADE,
  generation uuid NOT NULL, sequence bigint NOT NULL, body text NOT NULL, hash text NOT NULL,
  saved_version integer NOT NULL, saved_sequence bigint NOT NULL, codec_state jsonb,
  retired_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (doc_id,generation),
  CONSTRAINT doc_live_archive_sequence CHECK (sequence BETWEEN 0 AND 9007199254740991 AND saved_sequence BETWEEN 0 AND sequence),
  CONSTRAINT doc_live_archive_hash CHECK (hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT doc_live_archive_body CHECK (char_length(body) <= 100000),
  CONSTRAINT doc_live_archive_codec_bytes CHECK (codec_state IS NULL OR octet_length(codec_state::text) <= 8388608)
);
CREATE TABLE IF NOT EXISTS doc_live_updates (
  doc_id uuid NOT NULL REFERENCES project_materials(id) ON DELETE CASCADE,
  generation uuid NOT NULL, sequence bigint NOT NULL, actor_id text NOT NULL REFERENCES auth_users(id),
  command_id uuid NOT NULL, fingerprint text NOT NULL, bytes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (doc_id,generation,sequence), UNIQUE (actor_id,command_id),
  CONSTRAINT doc_live_update_sequence CHECK (sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT doc_live_update_fingerprint CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT doc_live_update_bytes CHECK (octet_length(bytes) <= 11184812)
);
CREATE TABLE IF NOT EXISTS doc_live_replicas (
  doc_id uuid NOT NULL REFERENCES project_materials(id) ON DELETE CASCADE,
  generation uuid NOT NULL, replica_id bigint NOT NULL, owner_kind text NOT NULL DEFAULT 'human', actor_id text REFERENCES auth_users(id),
  instance_id uuid NOT NULL, connection_id uuid, expires_at timestamptz NOT NULL,
  PRIMARY KEY (doc_id,generation,replica_id),
  CONSTRAINT doc_live_replica_owner CHECK ((owner_kind = 'human' AND actor_id IS NOT NULL) OR (owner_kind = 'server' AND actor_id IS NULL)),
  CONSTRAINT doc_live_replica_id CHECK (replica_id BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS doc_live_snapshots (
  doc_id uuid NOT NULL, version integer NOT NULL, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  generation uuid NOT NULL, from_sequence bigint NOT NULL, to_sequence bigint NOT NULL,
  hash text NOT NULL, contributors jsonb NOT NULL, PRIMARY KEY (doc_id,version),
  FOREIGN KEY (workspace_id,project_id,doc_id,version) REFERENCES project_material_versions(workspace_id,project_id,material_id,version) ON DELETE CASCADE,
  CONSTRAINT doc_live_snapshot_interval CHECK (from_sequence BETWEEN 0 AND to_sequence AND to_sequence <= 9007199254740991),
  CONSTRAINT doc_live_snapshot_hash CHECK (hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT doc_live_snapshot_contributors CHECK (jsonb_typeof(contributors) = 'array' AND octet_length(contributors::text) <= 8388608)
);
CREATE TABLE IF NOT EXISTS live_editing_intents (
  actor_id text NOT NULL REFERENCES auth_users(id), command_id uuid NOT NULL,
  workspace_id uuid NOT NULL, kind text NOT NULL, resource_id uuid NOT NULL, generation uuid NOT NULL,
  operation text NOT NULL, fingerprint text NOT NULL, byte_length integer NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (actor_id,command_id),
  CONSTRAINT live_editing_intent_kind CHECK (kind IN ('wiki','map')),
  CONSTRAINT live_editing_intent_fingerprint CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT live_editing_intent_bytes CHECK (byte_length BETWEEN 0 AND 8388608),
  CONSTRAINT live_editing_intent_receipt CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 8388608)
);

CREATE OR REPLACE FUNCTION immutable_live_editing_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'live editing history and receipts are immutable' USING ERRCODE = 'check_violation'; END $$;
DROP TRIGGER IF EXISTS doc_live_archive_immutable ON doc_live_archives;
CREATE TRIGGER doc_live_archive_immutable BEFORE UPDATE ON doc_live_archives FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();
DROP TRIGGER IF EXISTS doc_live_update_immutable ON doc_live_updates;
CREATE TRIGGER doc_live_update_immutable BEFORE UPDATE ON doc_live_updates FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();
DROP TRIGGER IF EXISTS doc_live_snapshot_immutable ON doc_live_snapshots;
CREATE TRIGGER doc_live_snapshot_immutable BEFORE UPDATE ON doc_live_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();
DROP TRIGGER IF EXISTS live_editing_intent_immutable ON live_editing_intents;
CREATE TRIGGER live_editing_intent_immutable BEFORE UPDATE OR DELETE ON live_editing_intents FOR EACH ROW EXECUTE FUNCTION immutable_live_editing_record();
CREATE OR REPLACE FUNCTION live_replica_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.doc_id,NEW.generation,NEW.replica_id,NEW.owner_kind,NEW.actor_id,NEW.instance_id)
    IS DISTINCT FROM (OLD.doc_id,OLD.generation,OLD.replica_id,OLD.owner_kind,OLD.actor_id,OLD.instance_id) THEN
    RAISE EXCEPTION 'live replica ownership is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS doc_live_replica_immutable ON doc_live_replicas;
CREATE TRIGGER doc_live_replica_immutable BEFORE UPDATE ON doc_live_replicas FOR EACH ROW EXECUTE FUNCTION live_replica_ownership_immutable();
