-- Guarded pre-use reversal of 0045 (#154). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. The previous schema cannot represent a stored file or an attachment-only
-- message, so this refuses (and changes nothing) once any file was staged. After real use, preserve the
-- upgraded database and files volume, and recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_files) OR EXISTS (SELECT 1 FROM file_garbage) THEN
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
DROP TABLE file_garbage;
ALTER TABLE project_messages DROP CONSTRAINT project_messages_file_identity;

CREATE OR REPLACE FUNCTION search_index_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('message:' || NEW.id, 'message', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text,
    NEW.conversation_id, NULL, NULL, '', NEW.body,
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END,
    coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;
