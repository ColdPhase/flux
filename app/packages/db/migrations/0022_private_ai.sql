-- #842 (F-036 AG-4): `/ai` works in every conversation and is answered privately; Show everyone posts it. Flux has no
-- installations or data yet (founder, 2026-10-31): nothing is converted.

-- A run belongs to a place. A space's conversation (`project_id`, with `conversation_id` unless it is the space's main
-- conversation), a direct message (`dm_id`), or no conversation of a space at all: the private chat with one of the owner's agents
-- (all three NULL). Only a run in a space has an AI epoch: a space is the only place with its own AI switch (AG-10).
ALTER TABLE public.personal_runs ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.personal_runs ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE public.personal_runs ALTER COLUMN ai_epoch DROP NOT NULL;
ALTER TABLE public.personal_runs ADD COLUMN dm_id uuid;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_dm_fkey FOREIGN KEY (workspace_id, dm_id) REFERENCES public.dms(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_place_check CHECK (
  (conversation_id IS NULL OR project_id IS NOT NULL) AND (dm_id IS NULL OR project_id IS NULL) AND ((project_id IS NOT NULL) = (ai_epoch IS NOT NULL)));
-- A task's run, a schedule's firing and the morning summary are anchored in a conversation of a space.
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_anchor_check CHECK (
  kind = ANY (ARRAY['ask', 'summarize', 'map_thought']) OR conversation_id IS NOT NULL);
CREATE INDEX personal_runs_dm_idx ON public.personal_runs USING btree (dm_id, created_at DESC) WHERE (dm_id IS NOT NULL);
CREATE INDEX personal_runs_chat_idx ON public.personal_runs USING btree (agent_id, created_at DESC) WHERE (project_id IS NULL AND dm_id IS NULL);

-- The answer of `/ai` and of a chat is its owner's alone. Show everyone posts it as the owner's message ("Ada · via Assistant");
-- Dismiss puts it away. Neither changes the run.
ALTER TABLE public.personal_runs ADD COLUMN shown_at timestamp with time zone;
ALTER TABLE public.personal_runs ADD COLUMN dismissed_at timestamp with time zone;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_put_away_check CHECK (shown_at IS NULL OR dismissed_at IS NULL);

-- A space without an AI epoch has no admission to check (a DM or a chat); a space run is admitted as before.
CREATE OR REPLACE FUNCTION public.ai_work_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pid uuid;
  policy record;
BEGIN
  IF TG_TABLE_NAME = 'assistant_reaction_events' THEN
    SELECT project_id INTO pid FROM assistant_reactions WHERE id = NEW.reaction_id;
  ELSE
    pid := NEW.project_id;
  END IF;
  IF pid IS NULL AND TG_TABLE_NAME = 'personal_runs' THEN
    RETURN NEW;
  END IF;
  SELECT state, epoch INTO policy FROM project_ai_policies WHERE project_id = pid FOR SHARE;
  IF NOT FOUND OR policy.state <> 'allowed' OR NEW.ai_epoch IS DISTINCT FROM policy.epoch THEN
    RAISE EXCEPTION 'AI is turned off in this space' USING ERRCODE = 'FX403', HINT = 'SPACE_AI_OFF';
  END IF;
  RETURN NEW;
END $$;

-- "Ada · via Assistant": a message a person posted with Show everyone names the agent that wrote it. The person stays the author.
ALTER TABLE public.project_messages ADD COLUMN via text;
ALTER TABLE public.project_messages ADD CONSTRAINT project_messages_via_check CHECK (via IS NULL OR (author_id IS NOT NULL AND char_length(via) BETWEEN 1 AND 80));
ALTER TABLE public.dm_messages ADD COLUMN via text;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_via_check CHECK (via IS NULL OR char_length(via) BETWEEN 1 AND 80);

-- AI in a DM between people shows both of them one line (AG-4): "Ada used AI here (Claude)". The line is a message of the person whose
-- body is the name of the company that receives the conversation; it is not a message to read, search or be notified about.
ALTER TABLE public.dm_messages ADD COLUMN kind text DEFAULT 'text' NOT NULL;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_kind_check CHECK (kind = ANY (ARRAY['text', 'ai_used']));
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_ai_used_check CHECK (kind = 'text' OR (via IS NULL AND thread_root_id IS NULL));
CREATE OR REPLACE FUNCTION public.search_index_dm_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'dm_message:' || OLD.id; RETURN OLD; END IF;
  IF NEW.kind <> 'text' THEN RETURN NEW; END IF;
  PERFORM search_put('dm_message:' || NEW.id, 'dm_message', NEW.workspace_id, 'dm:' || NEW.dm_id, NULL, NEW.id::text,
    NEW.dm_id, NULL, NULL, '', NEW.body, 'human', NEW.author_id, NEW.created_at);
  RETURN NEW;
END $$;

-- What an agent says on its own in its private chat (AG-4, AG-7): the reports of its work ("Done: #4 … · 3 changes · Undo"), each about one run.
-- The owner's messages and the answers to them are runs; these are the agent's own lines. `key` makes a report post once however often it is tried.
CREATE TABLE public.agent_chat_messages (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL REFERENCES public.assistant_settings(agent_id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES public.personal_runs(id) ON DELETE CASCADE,
    key text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_chat_messages_body_check CHECK (char_length(btrim(body)) BETWEEN 1 AND 100000),
    CONSTRAINT agent_chat_messages_key_check CHECK (char_length(key) BETWEEN 1 AND 200),
    CONSTRAINT agent_chat_messages_key_key UNIQUE (agent_id, key)
);
CREATE INDEX agent_chat_messages_agent_idx ON public.agent_chat_messages USING btree (agent_id, created_at DESC, id DESC);
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_chat_messages FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();
-- Until when the owner has read the chat of one agent: what came after is unread. An agent has one owner, so this is also per person.
CREATE TABLE public.agent_chat_reads (
    agent_id uuid PRIMARY KEY REFERENCES public.assistant_settings(agent_id) ON DELETE CASCADE,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_chat_reads FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();

-- The operations that store an idempotent response with no workspace (F-030).
INSERT INTO public.idempotency_account_operations (operation) VALUES
  ('POST /api/v1/projects/:projectId/assistant-runs'),
  ('POST /api/v1/dms/:dmId/assistant-runs'),
  ('POST /api/v1/my-agents/:agentId/assistant-runs'),
  ('POST /api/v1/assistant-runs/:runId/show'),
  ('POST /api/v1/assistant-runs/:runId/dismiss');
