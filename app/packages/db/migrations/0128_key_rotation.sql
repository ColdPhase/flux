-- F-030 encrypted workspaces, S2c key rotation (#655; docs/product/encrypted-workspaces.md#rotation). 0124-0127 are left
-- to the slices in flight (S2a-2b-2 files, S2b live and search); this file depends on none of them.
--
-- * `workspace_holders.confirmed_versions`: the key versions this holder has a confirmation for, covered by `holder_mac`
--   (S2a-1 review): a deleted `confirm` of a listed live version is tampering, never a fall-back to the commitment chain.
-- * A rotation starts whenever an owner or admin of a sealed workspace stops being one (removed, demoted, leaving or the
--   account deleted), with or without an unlock password: the membership trigger deletes their holder and the recovery
--   holder (the old code stops working) and leaves the rotation `pending`; the worker starts it while unlocked.
-- * Every deleted holder leaves a tombstone, the recovery holder too, so a restored row is never sealed to.
-- * `workspace_rotation_progress` gains the pass's change count (the verify invariant) and the start time (wire field).
ALTER TABLE workspace_holders ADD COLUMN confirmed_versions integer[] NOT NULL DEFAULT '{}';
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

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION workspace_holder_deleted() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION workspace_manager_lost() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
