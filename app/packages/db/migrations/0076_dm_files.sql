-- #1438 point 10: files, photos and videos go in direct messages like in a space. A direct message's file is a row of `project_files` that
-- belongs to the conversation (`dm_id`) instead of a project, and to a message of it (`dm_message_id`) once sent; exactly one of `project_id`
-- and `dm_id` is set, so every space's query, trigger and export (which read `project_id` and `message_id`) never sees it. A conversation's
-- file is for its current people only (access is checked where the bytes are read) and, like a space's, is removed with its message.
-- Works on data left by v0.2.0: a column made nullable, two new nullable columns, and checks that only widen what a row may hold.
ALTER TABLE public.project_files ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.project_files
  ADD COLUMN dm_id uuid,
  ADD COLUMN dm_message_id uuid,
  ADD CONSTRAINT project_file_one_scope CHECK (num_nonnulls(project_id, dm_id) = 1),
  ADD CONSTRAINT project_file_dm_message_scope CHECK (dm_message_id IS NULL OR dm_id IS NOT NULL),
  ADD CONSTRAINT project_files_dm_fkey FOREIGN KEY (workspace_id, dm_id) REFERENCES public.dms(workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT project_files_dm_message_fkey FOREIGN KEY (dm_id, dm_message_id) REFERENCES public.dm_messages(dm_id, id) ON DELETE CASCADE;

-- One upload id per person in one conversation, as in one project; one position per message.
CREATE UNIQUE INDEX project_files_dm_upload_idx ON public.project_files (dm_id, uploader_id, upload_id) WHERE dm_id IS NOT NULL AND uploader_id IS NOT NULL;
CREATE UNIQUE INDEX project_files_dm_message_position_idx ON public.project_files (dm_message_id, "position") WHERE dm_message_id IS NOT NULL;

-- A file is published to a message of a space, a message of a conversation or a map thought, never two; a poster follows its video.
ALTER TABLE public.project_files DROP CONSTRAINT project_file_publication;
ALTER TABLE public.project_files ADD CONSTRAINT project_file_publication CHECK (
  (((message_id IS NULL AND dm_message_id IS NULL) = ("position" IS NULL))
    OR (poster_of IS NOT NULL AND (message_id IS NOT NULL OR dm_message_id IS NOT NULL) AND "position" IS NULL))
  AND (num_nonnulls(message_id, dm_message_id, thought_id) <= 1)
  AND ((num_nonnulls(message_id, dm_message_id, thought_id) = 1) = (published_at IS NOT NULL)));

-- A message of a conversation may be only files, as a space's may (at most 10, like `project_messages`).
ALTER TABLE public.dm_messages ADD COLUMN attachment_count smallint DEFAULT 0 NOT NULL;
ALTER TABLE public.dm_messages
  ADD CONSTRAINT dm_message_attachment_count CHECK (attachment_count BETWEEN 0 AND 10),
  DROP CONSTRAINT dm_messages_body_check;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_body_check CHECK (
  public.flux_is_sealed(body) OR (length(btrim(body)) <= 100000 AND (length(btrim(body)) >= 1 OR attachment_count > 0)));
