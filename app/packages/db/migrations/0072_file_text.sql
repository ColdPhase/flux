-- Search finds what is inside the files people send (C-63, #1382).
--
-- A file attached to a space's message whose name says it holds text (PDF, DOCX, Markdown, plain text, CSV/TSV) becomes search
-- rows of kind `file`: one row for its name, which exists the moment the message is sent, and, once the worker has read the file
-- in a sandboxed process (apps/worker/src/file-text), one row for each part of its text (about 4,000 characters, so the optional
-- embeddings cover all of it and a snippet is cut from a small text). The rows carry the audience of the file's message
-- (`project:<id>`), so who finds a file is decided at query time exactly as for a message. A file removed with its message, a
-- deleted message, a deleted space: the rows go in the same transaction (the delete trigger), and a person who lost access to the
-- space finds nothing on the very next search.
--
-- Encrypted spaces are not indexed: no row, no job (their content is sealed, and a sealed file index would hold the text of whole
-- documents in the API's memory, which the 256 MiB bound of encrypted-workspaces.md does not leave room for).
--
-- Works on the data of any release from v0.2.0 on: it adds one column, one table, one index and the triggers, and queues the files
-- that are already there for the worker, which reads them in the background.

-- The page of a PDF where a row's text begins (null elsewhere): a hit opens the file at it.
ALTER TABLE public.search_documents ADD COLUMN page integer;
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_page_check CHECK (page IS NULL OR page >= 1);

ALTER TABLE public.search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_kind_check CHECK (kind = ANY (ARRAY['project'::text, 'message'::text,
  'dm_message'::text, 'material'::text, 'doc'::text, 'work'::text, 'decision'::text, 'result'::text, 'sketch'::text, 'thought'::text,
  'draft'::text, 'person'::text, 'file'::text]));

-- The rows of one file: its name and its text parts, found by the delete trigger, the worker's replacement and the read tool.
CREATE INDEX search_documents_file_idx ON public.search_documents (object_id, version) WHERE kind = 'file';

-- Files waiting to be read. The worker wakes on the NOTIFY below and polls nothing; `claimed_at` is the lease of the worker reading
-- the file (a lease that ran out is claimed again), `attempts` how many times it was claimed.
CREATE TABLE public.file_text_jobs (
    file_id uuid NOT NULL REFERENCES public.project_files(id) ON DELETE CASCADE,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT file_text_jobs_pkey PRIMARY KEY (file_id)
);
CREATE INDEX file_text_jobs_order_idx ON public.file_text_jobs (queued_at, file_id);

-- Whether the name of a file says that Flux reads its text. The one list for the triggers, the backfill and the worker's check
-- (packages/core/src/file-text/kinds.ts holds the same list, and a test compares them).
CREATE FUNCTION public.file_text_extractable(p_name text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT lower(p_name) ~ '\.(pdf|docx|md|markdown|txt|text|log|csv|tsv)$' $$;

-- A file is published with its message: its name becomes a search row and the file is queued for the worker.
CREATE FUNCTION public.search_index_file() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF workspace_sealed(NEW.workspace_id) OR NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO search_documents(doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body,
    author_kind, author_id, at, sealed)
  SELECT 'file:' || NEW.id || ':0', 'file', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, m.conversation_id, 0, NULL,
    NEW.name, '', CASE WHEN NEW.uploader_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(NEW.uploader_id, NEW.uploader_agent_id::text),
    NEW.published_at, false
  FROM project_messages m WHERE m.id = NEW.message_id
  ON CONFLICT (doc_key) DO NOTHING;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;
CREATE TRIGGER search_index_file AFTER UPDATE OF published_at ON public.project_files FOR EACH ROW
  WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.message_id IS NOT NULL) EXECUTE FUNCTION public.search_index_file();

-- A file goes (with its message or its space): its rows go with it. Its job goes by the foreign key.
CREATE FUNCTION public.search_unindex_file() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM search_documents WHERE kind = 'file' AND object_id = OLD.id::text;
  RETURN NULL;
END $$;
CREATE TRIGGER search_unindex_file AFTER DELETE ON public.project_files FOR EACH ROW EXECUTE FUNCTION public.search_unindex_file();

-- The files that are already there (v0.2.0's): the name rows now, the text by the worker as it gets to them.
INSERT INTO search_documents(doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body,
  author_kind, author_id, at, sealed)
SELECT 'file:' || f.id || ':0', 'file', f.workspace_id, 'project:' || f.project_id, f.project_id, f.id::text, m.conversation_id, 0, NULL,
  f.name, '', CASE WHEN f.uploader_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(f.uploader_id, f.uploader_agent_id::text), f.published_at, false
FROM project_files f JOIN project_messages m ON m.id = f.message_id
WHERE f.published_at IS NOT NULL AND f.state = 'ready' AND NOT workspace_sealed(f.workspace_id) AND file_text_extractable(f.name)
ON CONFLICT (doc_key) DO NOTHING;
INSERT INTO file_text_jobs (file_id)
SELECT f.id FROM project_files f
WHERE f.published_at IS NOT NULL AND f.message_id IS NOT NULL AND f.state = 'ready' AND NOT workspace_sealed(f.workspace_id) AND file_text_extractable(f.name)
ON CONFLICT DO NOTHING;
