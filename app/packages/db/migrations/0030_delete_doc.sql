-- A page can be deleted (#941). A message that cited a version of it keeps its text and says the page is deleted: the
-- citation is cleared and `source_deleted` set in the same transaction as the delete. A live room on a page ends with it,
-- and an ended session keeps the page's id as history, so the session no longer holds a foreign key on the page. A trigger
-- keeps the rest of what the key held: a session names a page of its own space. It fires when a session is created or
-- its page or space changes, not when the room ends, and it locks the page as the key did, so a delete waits for a room being made.
ALTER TABLE public.project_messages ADD COLUMN source_deleted boolean DEFAULT false NOT NULL;
ALTER TABLE public.project_messages ADD CONSTRAINT project_message_source_deleted
  CHECK (NOT source_deleted OR (source_material_id IS NULL AND source_material_version IS NULL));
ALTER TABLE public.live_sessions DROP CONSTRAINT live_sessions_workspace_id_project_id_doc_id_fkey;

CREATE FUNCTION public.live_session_doc_in_space() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.doc_id IS NULL OR TG_OP = 'UPDATE' AND NEW.doc_id IS NOT DISTINCT FROM OLD.doc_id
     AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
    RETURN NEW;
  END IF;
  PERFORM pm.id FROM project_materials pm
    WHERE pm.id = NEW.doc_id AND pm.kind = 'doc' AND pm.workspace_id = NEW.workspace_id AND pm.project_id = NEW.project_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a live session''s page must be a page of its own space'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_sessions_doc_in_space';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER live_sessions_doc_in_space BEFORE INSERT OR UPDATE OF doc_id, project_id, workspace_id ON public.live_sessions
  FOR EACH ROW EXECUTE FUNCTION public.live_session_doc_in_space();
