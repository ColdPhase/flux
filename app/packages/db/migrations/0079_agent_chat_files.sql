-- #1438 point 10, the agent's half (C-64 point 4): files, photos and videos go in an agent's private chat as in a space. A chat's file is a row of
-- `project_files` that belongs to the chat of one agent (`agent_id`) instead of a space or a direct message, and once sent to the owner's
-- request in that chat (`run_id`, the run that request is); exactly one of `project_id`, `dm_id` and `agent_id` is set, so no space's or direct
-- message's query, trigger, export or search ever sees it. Only the agent's owner reaches it (checked where it is read), and only the runs of
-- that chat. It goes with its run, its agent (deleted, that is revoked) or its company, its bytes to the deletion queue.
-- Works on data left by v0.2.0 and by 0076: two new nullable columns, checks that only widen what a row may hold, a new table and triggers.
ALTER TABLE public.project_files
  ADD COLUMN agent_id uuid,
  ADD COLUMN run_id uuid,
  ADD CONSTRAINT project_files_agent_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES public.agents(workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT project_files_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE,
  ADD CONSTRAINT project_file_run_scope CHECK (run_id IS NULL OR agent_id IS NOT NULL);
ALTER TABLE public.project_files DROP CONSTRAINT project_file_one_scope;
ALTER TABLE public.project_files ADD CONSTRAINT project_file_one_scope CHECK (num_nonnulls(project_id, dm_id, agent_id) = 1);

-- One upload id per person in one chat, as in one space; one position per request.
CREATE UNIQUE INDEX project_files_chat_upload_idx ON public.project_files (agent_id, uploader_id, upload_id) WHERE agent_id IS NOT NULL AND uploader_id IS NOT NULL;
CREATE UNIQUE INDEX project_files_run_position_idx ON public.project_files (run_id, "position") WHERE run_id IS NOT NULL;

-- A file is published to a message of a space, of a direct message, to a request in a chat or to a map thought, never two; a poster follows its video.
ALTER TABLE public.project_files DROP CONSTRAINT project_file_publication;
ALTER TABLE public.project_files ADD CONSTRAINT project_file_publication CHECK (
  (((message_id IS NULL AND dm_message_id IS NULL AND run_id IS NULL) = ("position" IS NULL))
    OR (poster_of IS NOT NULL AND (message_id IS NOT NULL OR dm_message_id IS NOT NULL OR run_id IS NOT NULL) AND "position" IS NULL))
  AND (num_nonnulls(message_id, dm_message_id, run_id, thought_id) <= 1)
  AND ((num_nonnulls(message_id, dm_message_id, run_id, thought_id) = 1) = (published_at IS NOT NULL)));

-- A chat's file that goes (with its run, its agent, or unsent after 7 days) leaves its bytes to the deletion queue, as a deleted message's do.
CREATE FUNCTION public.agent_chat_file_gone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO file_garbage (id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_chat_file_gone AFTER DELETE ON public.project_files FOR EACH ROW WHEN (OLD.agent_id IS NOT NULL)
  EXECUTE FUNCTION public.agent_chat_file_gone();

-- A deleted agent keeps its row, revoked (its owner's Delete, or an admin's revoke; neither is undone), so the cascade above never runs for
-- it: its chat's files, sent or staged, go when it is revoked, their bytes to the deletion queue by the trigger above.
CREATE FUNCTION public.agent_revoked_chat_files() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM project_files WHERE agent_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_revoked_chat_files AFTER UPDATE OF revoked_at ON public.agents FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION public.agent_revoked_chat_files();

-- The text of a chat's file (C-63's reader, C-64 point 4): read once by the same sandboxed worker when the request is sent, for the runs of that
-- chat only (`flux_read_file`). It is never a search row: nobody's search, and no run elsewhere, finds it. It goes with its file.
CREATE TABLE public.agent_chat_file_text (
    file_id uuid NOT NULL,
    part integer NOT NULL,
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    page integer,
    body text NOT NULL,
    CONSTRAINT agent_chat_file_text_pkey PRIMARY KEY (file_id, part),
    CONSTRAINT agent_chat_file_text_file_fkey FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE,
    CONSTRAINT agent_chat_file_text_part_check CHECK (part >= 1)
);
-- AI is always off in an encrypted workspace (F-029): no text of a chat's file is ever kept for one.
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_chat_file_text FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();

-- A chat's file is queued for the worker when its request is sent, as a space's is with its message (0072).
CREATE FUNCTION public.agent_chat_file_text_job() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF workspace_sealed(NEW.workspace_id) OR NOT file_text_extractable(NEW.name) THEN RETURN NULL; END IF;
  INSERT INTO file_text_jobs (file_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM pg_notify('flux_file_text', '');
  RETURN NULL;
END $$;
CREATE TRIGGER agent_chat_file_text_job AFTER UPDATE OF published_at ON public.project_files FOR EACH ROW
  WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.run_id IS NOT NULL) EXECUTE FUNCTION public.agent_chat_file_text_job();

-- A request in a chat may be files alone, as a message may (at most 10).
ALTER TABLE public.personal_runs ADD COLUMN attachment_count smallint DEFAULT 0 NOT NULL;
ALTER TABLE public.personal_runs
  ADD CONSTRAINT personal_run_attachment_count CHECK (attachment_count BETWEEN 0 AND 10),
  DROP CONSTRAINT personal_runs_prompt_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_prompt_check CHECK (
  length(btrim(prompt)) <= 4000 AND (length(btrim(prompt)) >= 1 OR attachment_count > 0));
