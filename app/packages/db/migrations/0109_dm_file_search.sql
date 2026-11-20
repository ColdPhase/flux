-- Files in a direct message are searchable by its people, with OCR when it is on, and readable by /ai in that conversation (C-64 (3), founder decision,
-- Hubert, 2026-11-20, #1590). A file follows its message: the same search rows as a space's file (kind `file`: one for the name, one for each part of the
-- text the worker reads, C-63, C-70) with the audience of the conversation's own messages, `dm:<id>` (`project_id` null, `parent_id` the conversation), so who
-- finds them is decided at query time by the rule that already decides who finds the conversation's messages, and no new permission exists. They go in the
-- transaction that deletes the file (the delete trigger of 0072 is by file, whatever its place). An encrypted workspace's files get no row and no job.
--
-- Works on the data of v0.2.1 (the release that had files in direct messages, 0076): it adds one trigger function and one trigger, gives the direct message
-- files that are already there the name row they lack, and queues the readable ones for the worker, which reads them in the background one at a time under
-- the limits of C-63 (a picture or a scan is read by OCR in the bounded batches of C-70 (7), when the switch is on). Nothing stored changes shape.
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

-- A file is published with its direct message: its name becomes a search row and the readable kinds are queued for the worker. A video's poster is the
-- picture of its video, not a file anyone sent: no row (0088).
CREATE FUNCTION public.search_index_dm_file() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.poster_of IS NOT NULL OR workspace_sealed(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM search_put('file:' || NEW.id || ':0', 'file', NEW.workspace_id, 'dm:' || NEW.dm_id, NULL, NEW.id::text, NEW.dm_id, 0,
    NULL, NEW.name, '', 'human', NEW.uploader_id, NEW.published_at);
  -- A picture wakes the worker, which queues it when OCR is on (and does nothing when it is off), as in 0104.
  IF file_ocr_picture(NEW.name) THEN PERFORM pg_notify('flux_file_text', ''); RETURN NULL; END IF;
  IF NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;
CREATE TRIGGER search_index_dm_file AFTER UPDATE OF published_at ON public.project_files FOR EACH ROW
  WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.dm_message_id IS NOT NULL) EXECUTE FUNCTION public.search_index_dm_file();

-- The direct message files that are already there (v0.2.1's) and have no name row: the name rows now, the text by the worker as it gets to them.
-- One statement, the row `search_put` writes for a file of a plain workspace (not sealed: no placeholder): the BM25 index writes a segment for
-- each statement (0093), so a `search_put` per file would add one segment per file to it within this transaction, about 100 kB each on disk
-- (measured on Flux's image, 2026-11-20: 2,000 files grew the index by 207 MB, which stayed after the merge).
INSERT INTO search_documents (doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body,
    author_kind, author_id, at, sealed)
SELECT 'file:' || f.id || ':0', 'file', f.workspace_id, 'dm:' || f.dm_id, NULL, f.id::text, f.dm_id, 0, NULL, f.name, '', 'human', f.uploader_id,
    f.published_at, false
FROM project_files f
WHERE f.dm_message_id IS NOT NULL AND f.published_at IS NOT NULL AND f.state = 'ready' AND f.poster_of IS NULL AND NOT workspace_sealed(f.workspace_id)
ON CONFLICT (doc_key) DO NOTHING;
INSERT INTO file_text_jobs (file_id)
SELECT f.id FROM project_files f
WHERE f.dm_message_id IS NOT NULL AND f.published_at IS NOT NULL AND f.state = 'ready' AND f.poster_of IS NULL AND f.size IS NOT NULL
  AND NOT workspace_sealed(f.workspace_id) AND file_text_extractable(f.name)
ON CONFLICT DO NOTHING;
