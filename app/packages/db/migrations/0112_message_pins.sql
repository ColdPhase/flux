-- Pinned messages (C-74, #1615; founder decision, Hubert, 2026-11-20). One rule: a pin belongs to the conversation and everyone in it sees the
-- same list. One table: which message is pinned, in which conversation, by whom and when; never the message's words, so an encrypted space
-- stores nothing more than this.
--
-- - The conversation is exactly one of a space (`project_id`, its stream and its threads), a direct message (`dm_id`) or a person's chat with
--   their own agent (`agent_id`). The message is one of that conversation's: a space's message, a direct message's message, or in an agent's
--   chat a run (its request or its answer, `run_part`) or one of the agent's own lines. A message is pinned at most once.
-- - The rows go with what they name: a removed space, direct message, agent or run takes its pins (the foreign keys cascade). A message the
--   author deletes keeps its row as the "Message removed" marker, so the delete takes its pin in the same transaction
--   (`messageChangeRows.removeProject` / `removeDm`), and an agent's answer that Undo removes takes its pin the same way
--   (`assistantRemovalRows`). Every read leaves out a removed message.
-- - A pin outlives the person who pinned it: it is the conversation's, not theirs. Deleting that person empties `pinned_by`, and the list says
--   "Pinned by a former member".
--
-- v0.2.1 data: the table is new and empty; nothing is pinned after the upgrade and nothing is backfilled.
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.message_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid,
    dm_id uuid,
    agent_id uuid,
    project_message_id uuid,
    dm_message_id uuid,
    run_id uuid,
    run_part text,
    agent_chat_message_id uuid,
    pinned_by text,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_pins_pkey PRIMARY KEY (id),
    CONSTRAINT message_pins_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_project_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_dm_fkey FOREIGN KEY (dm_id) REFERENCES public.dms(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_agent_fkey FOREIGN KEY (agent_id) REFERENCES public.assistant_settings(agent_id) ON DELETE CASCADE,
    CONSTRAINT message_pins_project_message_fkey FOREIGN KEY (project_message_id) REFERENCES public.project_messages(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_dm_message_fkey FOREIGN KEY (dm_message_id) REFERENCES public.dm_messages(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_agent_chat_message_fkey FOREIGN KEY (agent_chat_message_id) REFERENCES public.agent_chat_messages(id) ON DELETE CASCADE,
    CONSTRAINT message_pins_pinned_by_fkey FOREIGN KEY (pinned_by) REFERENCES public.auth_users(id) ON DELETE SET NULL,
    CONSTRAINT message_pins_one_place CHECK (num_nonnulls(project_id, dm_id, agent_id) = 1),
    CONSTRAINT message_pins_one_message CHECK (num_nonnulls(project_message_id, dm_message_id, run_id, agent_chat_message_id) = 1),
    CONSTRAINT message_pins_message_of_place CHECK ((project_id IS NULL) = (project_message_id IS NULL) AND (dm_id IS NULL) = (dm_message_id IS NULL)
      AND (agent_id IS NULL) = (run_id IS NULL AND agent_chat_message_id IS NULL)),
    CONSTRAINT message_pins_run_part CHECK ((run_id IS NULL) = (run_part IS NULL) AND (run_part IS NULL OR run_part IN ('prompt', 'answer')))
);

CREATE UNIQUE INDEX message_pins_project_message_idx ON public.message_pins (project_message_id) WHERE project_message_id IS NOT NULL;
CREATE UNIQUE INDEX message_pins_dm_message_idx ON public.message_pins (dm_message_id) WHERE dm_message_id IS NOT NULL;
CREATE UNIQUE INDEX message_pins_run_idx ON public.message_pins (run_id, run_part) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX message_pins_agent_chat_message_idx ON public.message_pins (agent_chat_message_id) WHERE agent_chat_message_id IS NOT NULL;
CREATE INDEX message_pins_project_idx ON public.message_pins (project_id, pinned_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX message_pins_dm_idx ON public.message_pins (dm_id, pinned_at DESC) WHERE dm_id IS NOT NULL;
CREATE INDEX message_pins_agent_idx ON public.message_pins (agent_id, pinned_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX message_pins_pinned_by_idx ON public.message_pins (pinned_by);
