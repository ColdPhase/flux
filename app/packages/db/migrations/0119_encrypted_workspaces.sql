-- F-030 encrypted workspaces (#655, S1; 0119 because 0118 is #664's). docs/product/encrypted-workspaces.md
--  * `workspaces.encrypted`, chosen at creation and immutable; `creation_id` for create retries.
--  * The key tables: key versions, holders (X25519 key pairs, private key wrapped under a password- or code-derived
--    KEK, authenticated by a MAC under the DEK), DEK wraps per holder and version, and unlock rows (DEKs sealed under
--    the keyring's boot key). No DEK, KEK, boot key, password or recovery code ever reaches this database.
--  * The shared failed-attempt limiter, first-password grants, rotation progress (S2c) and locked-job waits (S2a).
--  * AI forced off: the F-029 policy row is `blocked` at creation and can never become `allowed`; the
--    `sealed_workspace_no_ai` backstop refuses AI rows of a sealed workspace on every AI table with a workspace path.
--  * `notifications.reason` gains `security`.
-- Every error raised here uses SQLSTATE FX409 with the domain code as HINT; the API maps it to 409.
ALTER TABLE workspaces ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN creation_id uuid;
CREATE UNIQUE INDEX workspaces_creation ON workspaces (created_by, creation_id) WHERE creation_id IS NOT NULL;

CREATE FUNCTION workspace_encryption_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.encrypted IS DISTINCT FROM OLD.encrypted THEN
    RAISE EXCEPTION 'A workspace''s encryption is chosen at creation and cannot change' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_encryption_immutable BEFORE UPDATE OF encrypted ON workspaces FOR EACH ROW EXECUTE FUNCTION workspace_encryption_immutable();

CREATE FUNCTION workspace_sealed(uuid) RETURNS boolean STABLE LANGUAGE sql AS
  $$ SELECT coalesce((SELECT encrypted FROM workspaces WHERE id = $1), false) $$;

CREATE FUNCTION flux_max_version(integer[]) RETURNS integer IMMUTABLE LANGUAGE sql AS $$ SELECT max(v) FROM unnest($1) v $$;

CREATE TABLE workspace_keys (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  live_versions integer[] NOT NULL DEFAULT '{1}',
  rotation text NOT NULL DEFAULT 'none' CHECK (rotation IN ('none', 'pending', 'reencrypting')),
  rotation_reason jsonb CHECK (rotation_reason IS NULL OR jsonb_typeof(rotation_reason) = 'object'),
  tampered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- New seals use current_version, the newest live version; live_versions are the versions that may still have ciphertext.
  CHECK (cardinality(live_versions) >= 1 AND current_version = flux_max_version(live_versions))
);

CREATE TABLE workspace_key_versions (
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  key_version integer NOT NULL CHECK (key_version >= 1),
  commitment text,
  check_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key_version),
  CHECK ((key_version = 1) = (commitment IS NULL))
);

-- Tombstones: holders removed since the last finished rotation. A rotation's start never seals to a holder id or
-- public key listed here (S2c); the finish clears them.
CREATE TABLE workspace_removed_holders (
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  holder_id uuid NOT NULL,
  user_id text,
  public_key text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, holder_id)
);

CREATE TABLE workspace_holders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('password', 'recovery')),
  user_id text REFERENCES auth_users(id) ON DELETE CASCADE,
  kdf jsonb NOT NULL CHECK (jsonb_typeof(kdf) = 'object'),
  public_key text NOT NULL,
  wrapped_private text NOT NULL,
  holder_mac text NOT NULL,
  holder_mac_version integer NOT NULL CHECK (holder_mac_version >= 1),
  -- HMAC under a key from the KEK: tells a wrong password from a row changed outside Flux (see holders.ts).
  secret_check text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'recovery') = (user_id IS NULL))
);
CREATE UNIQUE INDEX workspace_holders_person ON workspace_holders (workspace_id, user_id) WHERE kind = 'password';
CREATE UNIQUE INDEX workspace_holders_recovery ON workspace_holders (workspace_id) WHERE kind = 'recovery';
CREATE INDEX workspace_holders_user ON workspace_holders (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE workspace_dek_wraps (
  holder_id uuid NOT NULL REFERENCES workspace_holders(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  key_version integer NOT NULL CHECK (key_version >= 1),
  ephemeral_public text NOT NULL,
  sealed_dek text NOT NULL,
  confirm text,
  PRIMARY KEY (holder_id, key_version)
);
CREATE INDEX workspace_dek_wraps_workspace ON workspace_dek_wraps (workspace_id, key_version);

CREATE TABLE workspace_unlocks (
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  key_version integer NOT NULL CHECK (key_version >= 1),
  boot_id uuid NOT NULL,
  sealed_dek text NOT NULL,
  unlocked_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key_version)
);
CREATE INDEX workspace_unlocks_boot ON workspace_unlocks (boot_id);

CREATE TABLE workspace_rotation_progress (
  workspace_id uuid PRIMARY KEY REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  target_version integer NOT NULL,
  step text NOT NULL,
  cursor jsonb,
  rows_done bigint NOT NULL DEFAULT 0,
  rows_estimate bigint NOT NULL DEFAULT 0,
  passes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE project_files ADD COLUMN key_version integer CHECK (key_version IS NULL OR key_version >= 1);

-- One row per failed (or in-flight) password or recovery-code check, on any of the four checking routes.
CREATE TABLE password_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_attempts_person ON password_attempts (workspace_id, user_id, at);

CREATE TABLE workspace_wrap_grants (
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  granted_by text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sealed_job_waits (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  queue text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sealed_job_waits_workspace ON sealed_job_waits (workspace_id, created_at);

-- Holder deletions. The last password holder of an existing workspace cannot be deleted (an account deletion that
-- would cascade to it is refused); any other password holder's deletion leaves a rotation pending (S2c starts it).
CREATE FUNCTION workspace_holder_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'password' AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
    AND NOT EXISTS (SELECT 1 FROM workspace_holders WHERE workspace_id = OLD.workspace_id AND kind = 'password' AND id <> OLD.id) THEN
    RAISE EXCEPTION 'The workspace needs at least one unlock password' USING ERRCODE = 'FX409', HINT = 'LAST_UNLOCK_PASSWORD';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER workspace_holder_delete_guard BEFORE DELETE ON workspace_holders FOR EACH ROW EXECUTE FUNCTION workspace_holder_delete_guard();

-- Writes the tombstone and leaves a rotation pending from `none` or `reencrypting` (a holder of n+1 removed mid-rotation
-- needs n+2), so an account deletion that cascades here still leads to a rotation.
CREATE FUNCTION workspace_holder_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'password' AND EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = OLD.workspace_id) THEN
    INSERT INTO workspace_removed_holders (workspace_id, holder_id, user_id, public_key)
      VALUES (OLD.workspace_id, OLD.id, OLD.user_id, OLD.public_key) ON CONFLICT DO NOTHING;
    UPDATE workspace_keys SET rotation = 'pending', rotation_reason = jsonb_build_object('kind', 'holder_deleted', 'userId', OLD.user_id)
      WHERE workspace_id = OLD.workspace_id AND rotation IN ('none', 'reencrypting');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER workspace_holder_deleted AFTER DELETE ON workspace_holders FOR EACH ROW EXECUTE FUNCTION workspace_holder_deleted();

-- AI forced off (F-029 reuse): the policy row of an encrypted workspace starts blocked and never becomes allowed.
CREATE OR REPLACE FUNCTION workspace_ai_policy_create() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_ai_policies (workspace_id, state) VALUES (NEW.id, CASE WHEN NEW.encrypted THEN 'blocked' ELSE 'allowed' END);
  RETURN NEW;
END $$;
CREATE FUNCTION workspace_ai_policy_encrypted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'allowed' AND workspace_sealed(NEW.workspace_id) THEN
    RAISE EXCEPTION 'AI is always off in an encrypted workspace' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTED_AI_OFF';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_ai_policy_encrypted BEFORE INSERT OR UPDATE ON workspace_ai_policies FOR EACH ROW EXECUTE FUNCTION workspace_ai_policy_encrypted();

-- The backstop on every AI table: a row whose workspace (its own column, or through its project, agent or agent
-- connection) is sealed is refused. Values that are not UUIDs are ignored, so no insert fails here for another reason.
CREATE FUNCTION sealed_workspace_no_ai() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  uuid_text text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ws uuid;
BEGIN
  IF coalesce(r->>'workspace_id', '') ~* uuid_text THEN
    ws := (r->>'workspace_id')::uuid;
  ELSIF coalesce(r->>'project_id', '') ~* uuid_text THEN
    SELECT workspace_id INTO ws FROM projects WHERE id = (r->>'project_id')::uuid;
  ELSIF coalesce(r->>'agent_id', '') ~* uuid_text THEN
    SELECT workspace_id INTO ws FROM agents WHERE id = (r->>'agent_id')::uuid;
  ELSIF TG_TABLE_NAME LIKE 'agent%' AND coalesce(r->>'connection_id', '') ~* uuid_text THEN
    SELECT workspace_id INTO ws FROM agent_connections WHERE id = (r->>'connection_id')::uuid;
  END IF;
  IF ws IS NOT NULL AND workspace_sealed(ws) THEN
    RAISE EXCEPTION 'AI is always off in an encrypted workspace' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTED_AI_OFF';
  END IF;
  RETURN NEW;
END $$;
-- The AI class of S1 (S2a's TABLE_CLASSES replaces the patterns): every such table with a workspace path gets it.
-- The schema being migrated, not a fixed 'public' (#752): the same tables in an ordinary install, and in a fixture schema the
-- loop no longer reaches the public schema's tables (it met public.agent_pauses of 0131 there).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.tables c
    WHERE c.table_schema = current_schema() AND c.table_type = 'BASE TABLE'
      AND (c.table_name LIKE 'agent%' OR c.table_name LIKE 'assistant%' OR c.table_name LIKE 'cowork%' OR c.table_name LIKE 'personal_run%'
        OR c.table_name LIKE 'proactive_comparison%' OR c.table_name = 'background_compute_connections')
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = current_schema() AND k.table_name = c.table_name
        AND (k.column_name IN ('workspace_id', 'project_id', 'agent_id') OR (c.table_name LIKE 'agent%' AND k.column_name = 'connection_id')))
    ORDER BY c.table_name
  LOOP
    -- `a_` sorts it before every other BEFORE INSERT trigger of the table, so it refuses first.
    EXECUTE format('CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION sealed_workspace_no_ai()', t);
  END LOOP;
END $$;

-- NOT VALID, then VALIDATE: the full-table check runs without the exclusive lock of ADD CONSTRAINT.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason IN ('mention', 'question', 'reply', 'dm', 'assigned', 'review', 'invitation', 'security')) NOT VALID;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_reason_check;
