-- Edit and delete your own messages (#1006). A message keeps its place and id; an edit overwrites the words (no history) and stamps
-- `edited_at`; a delete replaces them with a fixed marker and stamps `removed_at`, as the assistant's Undo already does for a project
-- message. A direct message gets the same two columns. A removed message is not findable: the search index drops its row, so the text
-- is gone from search as well as from the table.
ALTER TABLE public.project_messages ADD COLUMN edited_at timestamp with time zone;
ALTER TABLE public.dm_messages ADD COLUMN edited_at timestamp with time zone, ADD COLUMN removed_at timestamp with time zone;

CREATE OR REPLACE FUNCTION public.search_index_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
  IF NEW.removed_at IS NOT NULL THEN DELETE FROM search_documents WHERE doc_key = 'message:' || NEW.id; RETURN NEW; END IF;
  PERFORM search_put('message:' || NEW.id, 'message', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text,
    NEW.conversation_id, NULL, NULL, CASE WHEN btrim(NEW.body) = '' THEN 'Attached files' ELSE '' END, NEW.body,
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END,
    coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.search_index_dm_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'dm_message:' || OLD.id; RETURN OLD; END IF;
  IF NEW.removed_at IS NOT NULL THEN DELETE FROM search_documents WHERE doc_key = 'dm_message:' || NEW.id; RETURN NEW; END IF;
  PERFORM search_put('dm_message:' || NEW.id, 'dm_message', NEW.workspace_id, 'dm:' || NEW.dm_id, NULL, NEW.id::text,
    NEW.dm_id, NULL, NULL, '', NEW.body, 'human', NEW.author_id, NEW.created_at);
  RETURN NEW;
END $$;
