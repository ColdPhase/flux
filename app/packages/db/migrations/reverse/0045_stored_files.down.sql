-- Guarded pre-use reversal of 0045 (#154). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. The previous schema cannot represent a stored file or an attachment-only
-- message, so this refuses (and changes nothing) once any file was staged. After real use, preserve the
-- upgraded database and files volume, and recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_files) THEN
    RAISE EXCEPTION '0045 reversal refused: stored files exist' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM project_messages WHERE attachment_count > 0) THEN
    RAISE EXCEPTION '0045 reversal refused: messages with attachments exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
ALTER TABLE project_messages DROP CONSTRAINT project_message_body_or_attachments;
ALTER TABLE project_messages ADD CONSTRAINT project_messages_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 100000);
ALTER TABLE project_messages DROP COLUMN attachment_count;
DROP TABLE project_files;
