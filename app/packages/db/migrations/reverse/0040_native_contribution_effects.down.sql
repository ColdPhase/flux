-- Guarded pre-use reversal of 0040 (#154). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. The previous schema cannot represent a native command receipt or a
-- blocker/result/handoff contribution, so this refuses (and changes nothing) once either exists. After real
-- use, preserve the upgraded data and recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM native_command_receipts) THEN
    RAISE EXCEPTION '0040 reversal refused: native command receipts exist' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM project_messages WHERE contribution_kind <> 'text' OR result_id IS NOT NULL) THEN
    RAISE EXCEPTION '0040 reversal refused: blocker, result or handoff contributions exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP TABLE native_command_receipts;
DROP INDEX project_messages_result_idx;
ALTER TABLE project_messages DROP CONSTRAINT project_message_result_scope;
ALTER TABLE project_messages DROP CONSTRAINT project_message_result_reference;
ALTER TABLE project_messages DROP CONSTRAINT project_message_contribution_kind;
ALTER TABLE project_messages DROP COLUMN result_id;
ALTER TABLE project_messages DROP COLUMN contribution_kind;
