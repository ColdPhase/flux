-- A PDF without text (a scan, an exported map, slides saved as pictures; C-69, #1557). The worker's sandboxed reader keeps the picture of
-- each of its first ten pages (a PNG of at most 1,568 px on its long side) for the agents whose model sees pictures, and marks the file
-- `no_text`, so its row and its preview say why search and agents find no words in it. The pictures go with their file.
-- 0096–0102 belong to other changes of v0.2.2 (assigned by the coordinator), so a gap is expected until they land.
ALTER TABLE public.project_files ADD COLUMN no_text boolean NOT NULL DEFAULT false;

CREATE TABLE public.file_page_pictures (
    file_id uuid NOT NULL REFERENCES public.project_files(id) ON DELETE CASCADE,
    page integer NOT NULL CHECK (page BETWEEN 1 AND 10),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 1568),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 1568),
    png bytea NOT NULL CHECK (octet_length(png) BETWEEN 33 AND 3600000),
    CONSTRAINT file_page_pictures_pkey PRIMARY KEY (file_id, page)
);

-- v0.2.1's PDFs that were read and had no text are read once more, so they get their pictures and their mark. Only a PDF of a plain
-- space or of an agent's chat that has no text row and no job now; nothing else is read again.
INSERT INTO file_text_jobs (file_id)
SELECT f.id FROM project_files f
WHERE f.published_at IS NOT NULL AND f.state = 'ready' AND (f.message_id IS NOT NULL OR (f.agent_id IS NOT NULL AND f.run_id IS NOT NULL))
  AND NOT workspace_sealed(f.workspace_id) AND lower(f.name) ~ '\.pdf$'
  AND NOT EXISTS (SELECT 1 FROM search_documents d WHERE d.kind = 'file' AND d.object_id = f.id::text AND d.version >= 1)
  AND NOT EXISTS (SELECT 1 FROM agent_chat_file_text t WHERE t.file_id = f.id)
ON CONFLICT DO NOTHING;
