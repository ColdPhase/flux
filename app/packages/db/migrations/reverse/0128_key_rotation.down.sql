-- Reversal of 0128 (F-030 S2c, #655). Not applied by the migrator.
DROP TRIGGER IF EXISTS workspace_manager_lost ON workspace_members;
DROP FUNCTION IF EXISTS workspace_manager_lost();
CREATE OR REPLACE FUNCTION workspace_holder_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'password' AND EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = OLD.workspace_id) THEN
    INSERT INTO workspace_removed_holders (workspace_id, holder_id, user_id, public_key)
      VALUES (OLD.workspace_id, OLD.id, OLD.user_id, OLD.public_key) ON CONFLICT DO NOTHING;
    UPDATE workspace_keys SET rotation = 'pending', rotation_reason = jsonb_build_object('kind', 'holder_deleted', 'userId', OLD.user_id)
      WHERE workspace_id = OLD.workspace_id AND rotation IN ('none', 'reencrypting');
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION workspace_holder_deleted() RESET search_path;
ALTER TABLE workspace_rotation_progress DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS pass_changes;
ALTER TABLE workspace_holders DROP COLUMN IF EXISTS confirmed_versions;
