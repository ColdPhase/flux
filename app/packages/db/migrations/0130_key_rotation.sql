-- F-030 encrypted workspaces, S2c key rotation (#655; docs/product/encrypted-workspaces.md#rotation). Numbered after
-- 0129 (main); it depends on 0119-0127 only.
--
-- * `workspace_holders.confirmed_versions`: the key versions this holder has a confirmation for, covered by `holder_mac`
--   (S2a-1 review): a deleted `confirm` of a listed live version is tampering, never a fall-back to the commitment chain.
-- * A rotation starts whenever an owner or admin of a sealed workspace stops being one (removed, demoted, leaving or the
--   account deleted), with or without an unlock password: the membership trigger deletes their holder and the recovery
--   holder (the old code stops working) and leaves the rotation `pending`; the worker starts it while unlocked.
-- * Every deleted holder leaves a tombstone, the recovery holder too, so a restored row is never sealed to.
-- * `workspace_rotation_progress` gains the pass's change count (the verify invariant) and the start time (wire field).
ALTER TABLE workspace_holders ADD COLUMN confirmed_versions integer[] NOT NULL DEFAULT '{}';
-- The key pin (S2c review): an HMAC under FLUX_KEY_PIN_SECRET, a deployment secret that is not in the database, over a
-- holder's identity and public key and over a key version's check value and commitment. Null on a row no server path
-- wrote: such a row fails verification (tampering).
ALTER TABLE workspace_holders ADD COLUMN pin text;
ALTER TABLE workspace_key_versions ADD COLUMN pin text;
-- A rotation that cannot finish (an unopenable value, or a copy of an old-version envelope outside the registry) says
-- where (a table and column name, never content) and since when.
-- Pinned removal records (S2c, founder-delegated decision 2026-10-30): every removed holder, kept for good (unlike the
-- tombstones, which the finish clears), each pinned under FLUX_KEY_PIN_SECRET and chained to the previous one, with
-- the chain's head on workspace_keys. A holder whose id or public key has a record is never sealed to again and makes
-- an unlock refuse; a deleted or altered record breaks the chain (tampering).
CREATE TABLE workspace_removals (
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  holder_id uuid NOT NULL,
  user_id text,
  public_key text NOT NULL,
  removed_version integer NOT NULL CHECK (removed_version >= 1),
  pin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, seq)
);
ALTER TABLE workspace_keys ADD COLUMN removal_head text;
ALTER TABLE workspace_rotation_progress ADD COLUMN stalled_on text;
-- The rotation's events carry ids only: `workspace.key_rotation_started.v1 { version, holders }`. 0125's event data guard
-- needs the key `holders` (EVENT_DATA_KEYS in contracts).
INSERT INTO event_data_keys (key) VALUES ('holders') ON CONFLICT DO NOTHING;
ALTER TABLE workspace_rotation_progress ADD COLUMN stalled_at timestamptz;
ALTER TABLE workspace_rotation_progress ADD COLUMN pass_changes bigint NOT NULL DEFAULT 0;
ALTER TABLE workspace_rotation_progress ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION workspace_holder_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = OLD.workspace_id) THEN
    INSERT INTO workspace_removed_holders (workspace_id, holder_id, user_id, public_key)
      VALUES (OLD.workspace_id, OLD.id, OLD.user_id, OLD.public_key) ON CONFLICT DO NOTHING;
    UPDATE workspace_keys SET rotation = 'pending', rotation_reason = jsonb_build_object('kind', 'holder_deleted', 'userId', OLD.user_id)
      WHERE workspace_id = OLD.workspace_id AND rotation IN ('none', 'reencrypting');
  END IF;
  RETURN NULL;
END $$;

-- An owner or admin losing the role. The role change already holds `workspace_keys` FOR UPDATE (F-030 lock order); an
-- account deletion reaches this through the membership cascade. A workspace being deleted is skipped.
CREATE FUNCTION workspace_manager_lost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role IN ('owner', 'admin') AND (TG_OP = 'DELETE' OR NEW.role NOT IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id AND encrypted)
    AND EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = OLD.workspace_id) THEN
    DELETE FROM workspace_holders WHERE workspace_id = OLD.workspace_id
      AND (kind = 'recovery' OR (kind = 'password' AND user_id = OLD.user_id));
    UPDATE workspace_keys SET rotation = 'pending',
      rotation_reason = jsonb_build_object('kind', CASE WHEN TG_OP = 'DELETE' THEN 'removed' ELSE 'demoted' END, 'userId', OLD.user_id)
      WHERE workspace_id = OLD.workspace_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER workspace_manager_lost AFTER UPDATE OF role OR DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION workspace_manager_lost();

-- 0124's content-free notification check gains the S2c template a stalled rotation sends every holder:
-- "<workspace>'s key change cannot finish yet. Ask your server's operator." (no content, the workspace's own name).
CREATE OR REPLACE FUNCTION flux_notification_content_free() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ws text;
  sep text;
  who text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  -- A read-state or delivery update keeps the stored text, which was checked when written: a later rename of the
  -- account or the workspace must not make the row impossible to mark read (#712 review P2-1).
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.body IS NOT DISTINCT FROM OLD.body
    AND NEW.url IS NOT DISTINCT FROM OLD.url AND NEW.workspace_id = OLD.workspace_id THEN RETURN NEW; END IF;
  -- The link carries ids only: one of the generator's forms with every id replaced (#712 review P3).
  IF NEW.url IS NOT NULL AND regexp_replace(NEW.url, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'ID', 'g')
    NOT IN ('/inbox', '/projects/ID/conversations/ID#message-ID', '/dm/ID#message-ID', '/projects/ID/tasks?open=work:ID',
      '/projects/ID/tasks?open=decision:ID', '/projects/ID/tasks?open=result:ID', '/projects/ID/live/ID?invitation=ID') THEN
    RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
  END IF;
  -- The plain morning summary: a count and a fixed body (#712 review P2-2).
  IF NEW.delivery_kind = 'morning_summary' AND NEW.body = 'Your morning summary from Flux'
    AND NEW.title ~ '^([0-9]{1,4}\+ things wait|1 thing waits|[0-9]{1,4} things wait) in your inbox$' THEN RETURN NEW; END IF;
  SELECT name INTO ws FROM workspaces WHERE id = NEW.workspace_id;
  IF NEW.body = '' THEN
    IF NEW.title = ws || '''s encryption keys were changed outside Flux. It stays locked.' THEN RETURN NEW; END IF;
    IF NEW.title = ws || '''s key change cannot finish yet. Ask your server''s operator.' THEN RETURN NEW; END IF;
    FOREACH sep IN ARRAY ARRAY[' mentioned you in ', ' asked you in ', ' replied in ', ' sent you a message in ', ' assigned you a task in ',
      ' asked for your review in ', ' invited you to work together in ', ' now has an unlock password for '] LOOP
      IF length(NEW.title) > length(sep || ws) AND right(NEW.title, length(sep || ws)) = sep || ws THEN
        who := left(NEW.title, length(NEW.title) - length(sep || ws));
        IF who IN ('Someone', 'An agent') OR EXISTS (SELECT 1 FROM auth_users u WHERE u.name = who) THEN RETURN NEW; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
END $$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_notification_content_free() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION workspace_holder_deleted() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION workspace_manager_lost() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
