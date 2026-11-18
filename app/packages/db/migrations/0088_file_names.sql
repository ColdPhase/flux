-- Search finds every file by its name (founder decision, Hubert, 2026-11-15, #1424 B): a photo, a video, a recording, a spreadsheet, any
-- kind, so "IMG_2041" finds IMG_2041.jpg. What a file says is still read only for the kinds of `file_text_extractable` (C-63, 0072).
--
-- Every file attached to a space's message gets its name row (`file:<id>:0`) when the message is sent, written by `search_put` like every
-- other row. In an encrypted space that row is the usual placeholder (`sealed`, an empty title and body): the name is never in a visible
-- column, and the in-memory index of the unlocked space opens it from `project_files.name` (sealed-search.ts), as it does every sealed
-- title. Such a file still gets no job: the text of an encrypted space's files is never read. A video's poster (`poster_of`, 0071) is
-- the picture of its video, not a file anyone sent: it gets no row, so searching "poster" does not list one hit per video.
--
-- Works on the data of any release from v0.2.0 on: it replaces one trigger function and gives the files that are already there the name
-- row they lack (the readable kinds of plain spaces have theirs since 0072).

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
  IF workspace_sealed(NEW.workspace_id) OR NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;

-- The files that are already there and have no name row: every kind in a plain space, every file in an encrypted one; never a poster.
SELECT count(search_put('file:' || f.id || ':0', 'file', f.workspace_id, 'project:' || f.project_id, f.project_id, f.id::text, m.conversation_id, 0,
    NULL, f.name, '', CASE WHEN f.uploader_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(f.uploader_id, f.uploader_agent_id::text), f.published_at))
FROM project_files f JOIN project_messages m ON m.id = f.message_id
WHERE f.published_at IS NOT NULL AND f.state = 'ready' AND f.poster_of IS NULL
  AND NOT EXISTS (SELECT 1 FROM search_documents d WHERE d.doc_key = 'file:' || f.id || ':0');
