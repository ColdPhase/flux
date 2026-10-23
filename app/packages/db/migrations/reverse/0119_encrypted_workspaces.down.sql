-- Reverses 0119 (F-030). Refuses while an encrypted workspace exists: its data cannot be read without these tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE encrypted) THEN
    RAISE EXCEPTION 'An encrypted workspace exists; 0119 cannot be reversed' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTION_IMMUTABLE';
  END IF;
END $$;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
DELETE FROM notifications WHERE reason = 'security';
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason IN ('mention', 'question', 'reply', 'dm', 'assigned', 'review', 'invitation'));
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT DISTINCT event_object_table FROM information_schema.triggers WHERE trigger_schema = 'public' AND trigger_name = 'a_sealed_workspace_no_ai'
  LOOP
    EXECUTE format('DROP TRIGGER a_sealed_workspace_no_ai ON %I', t);
  END LOOP;
END $$;
DROP FUNCTION sealed_workspace_no_ai();
DROP TRIGGER workspace_ai_policy_encrypted ON workspace_ai_policies;
DROP FUNCTION workspace_ai_policy_encrypted();
CREATE OR REPLACE FUNCTION workspace_ai_policy_create() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_ai_policies (workspace_id, state) VALUES (NEW.id, 'allowed');
  RETURN NEW;
END $$;
DROP TABLE sealed_job_waits, workspace_wrap_grants, password_attempts, workspace_rotation_progress, workspace_unlocks,
  workspace_dek_wraps, workspace_holders, workspace_removed_holders, workspace_key_versions, workspace_keys;
DROP FUNCTION workspace_holder_delete_guard();
DROP FUNCTION workspace_holder_deleted();
DROP FUNCTION flux_max_version(integer[]);
ALTER TABLE project_files DROP COLUMN key_version;
DROP TRIGGER workspace_encryption_immutable ON workspaces;
DROP FUNCTION workspace_encryption_immutable();
DROP FUNCTION workspace_sealed(uuid);
DROP INDEX workspaces_creation;
ALTER TABLE workspaces DROP COLUMN creation_id;
ALTER TABLE workspaces DROP COLUMN encrypted;
