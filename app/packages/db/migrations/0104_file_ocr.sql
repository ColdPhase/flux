-- OCR of scans and pictures (C-70, #1575): with the operator's FLUX_FILE_OCR=on, the worker reads the text in a PDF without a text layer
-- (C-69) and in the pictures people send (PNG, JPEG, WebP, GIF), in the same sandboxed reader, and keeps it as the file's text: search
-- rows like a PDF's own text, or a chat's file text. `ocr_state` says whether OCR has read the file: NULL (not yet, or the switch was off),
-- 'text' (its text was kept) or 'none' (nothing confident enough was found). A file of an encrypted space is never read.
-- 0096–0102 belong to other changes of v0.2.2 (assigned by the coordinator), so a gap is expected until they land.
ALTER TABLE public.project_files ADD COLUMN ocr_state text CHECK (ocr_state IN ('text', 'none'));

-- The names OCR reads besides a PDF: the pictures a browser shows (C-59). The worker checks the bytes too.
CREATE FUNCTION public.file_ocr_picture(p_name text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT lower(p_name) ~ '\.(png|jpe?g|webp|gif)$' $$;

-- What OCR has yet to read while the switch is on, newest first: the worker queues a bounded batch of these whenever its queue is empty,
-- so v0.2.1's pictures and scans are read a few at a time and a large install is never flooded with jobs.
CREATE INDEX project_files_ocr_pending_idx ON public.project_files (published_at DESC)
  WHERE ocr_state IS NULL AND published_at IS NOT NULL AND poster_of IS NULL AND (file_ocr_picture(name) OR (no_text AND lower(name) ~ '[.]pdf$'));

-- A picture sent to a space or a chat wakes the worker, which queues it when OCR is on (and does nothing when it is off).
CREATE OR REPLACE FUNCTION public.search_index_file() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.poster_of IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM search_put('file:' || NEW.id || ':0', 'file', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, m.conversation_id, 0,
    NULL, NEW.name, '', CASE WHEN NEW.uploader_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(NEW.uploader_id, NEW.uploader_agent_id::text),
    NEW.published_at)
  FROM project_messages m WHERE m.id = NEW.message_id;
  IF workspace_sealed(NEW.workspace_id) THEN RETURN NULL; END IF;
  IF file_ocr_picture(NEW.name) THEN PERFORM pg_notify('flux_file_text', ''); RETURN NULL; END IF;
  IF NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.agent_chat_file_text_job() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF workspace_sealed(NEW.workspace_id) THEN RETURN NULL; END IF;
  IF file_ocr_picture(NEW.name) THEN PERFORM pg_notify('flux_file_text', ''); RETURN NULL; END IF;
  IF NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;
