-- #859, #855 part 2 (F-036 AG-3, mcp-cowork LC-2): a local client follows the same owner rights and the same waiting as the
-- assistant, and standing grants go. Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.

-- A change in the change log comes from an assistant run or from a local client's connection (exactly one of the two). A
-- client's waiting change is approved, edited or skipped by its owner like the assistant's. `conversation_id` is the
-- conversation a client's message went to, so its change line (and Undo) can show on that message.
ALTER TABLE public.assistant_changes ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE public.assistant_changes ADD COLUMN connection_id uuid REFERENCES public.agent_connections(id) ON DELETE CASCADE;
ALTER TABLE public.assistant_changes ADD COLUMN conversation_id uuid;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_source_check CHECK (num_nonnulls(run_id, connection_id) = 1);
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_conversation_fk
  FOREIGN KEY (workspace_id, project_id, conversation_id) REFERENCES public.project_conversations(workspace_id, project_id, id) ON DELETE CASCADE;
CREATE UNIQUE INDEX assistant_changes_connection_command_idx ON public.assistant_changes USING btree (connection_id, client_command_id)
  WHERE (connection_id IS NOT NULL);
CREATE INDEX assistant_changes_connection_idx ON public.assistant_changes USING btree (connection_id, created_at) WHERE (connection_id IS NOT NULL);
CREATE INDEX assistant_changes_conversation_idx ON public.assistant_changes USING btree (conversation_id, created_at) WHERE (conversation_id IS NOT NULL);

-- Standing grants go: a client's authority is its owner's rights at the moment of each call. The task-thread guard keeps its
-- receipt check without comparing a grant.
CREATE OR REPLACE FUNCTION public.flux_complete_agent_thread_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.kind = 'agent_message' AND NOT EXISTS (
    SELECT 1 FROM project_messages m JOIN agent_command_receipts r
      ON r.connection_id = NEW.connection_id AND r.client_command_id = NEW.client_command_id
    JOIN agent_runtime_sessions runtime ON runtime.id = r.runtime_session_id AND runtime.connection_id = r.connection_id
    WHERE m.id = NEW.message_id AND m.author_agent_id = NEW.author_agent_id AND m.author_id IS NULL
      AND m.conversation_id = NEW.conversation_id AND m.project_id = NEW.project_id AND m.workspace_id = NEW.workspace_id
      AND runtime.agent_id = NEW.author_agent_id AND runtime.workspace_id = NEW.workspace_id
      AND r.runtime_session_id = NEW.runtime_session_id
      AND r.operation = 'conversation.reply' AND r.project_id = NEW.project_id
      AND r.value->>'taskId' = NEW.task_id::text AND r.value->>'conversationId' = NEW.conversation_id::text
      AND r.value->>'messageId' = NEW.message_id::text
      AND r.postconditions @> jsonb_build_array(jsonb_build_object('kind', 'message', 'id', NEW.message_id::text))
  ) THEN
    RAISE EXCEPTION 'Incomplete native task-thread receipt' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_receipt';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE public.agent_thread_guard_events DROP CONSTRAINT agent_thread_guard_events_check;
ALTER TABLE public.agent_thread_guard_events DROP COLUMN grant_id;
ALTER TABLE public.agent_thread_guard_events ADD CONSTRAINT agent_thread_guard_events_check CHECK (
  ((kind = 'agent_message'::text) AND (author_agent_id IS NOT NULL) AND (connection_id IS NOT NULL) AND (client_command_id IS NOT NULL) AND (runtime_session_id IS NOT NULL))
  OR ((kind = 'human_message'::text) AND (author_agent_id IS NULL) AND (connection_id IS NULL) AND (client_command_id IS NULL) AND (runtime_session_id IS NULL)));

ALTER TABLE public.agent_command_receipts DROP CONSTRAINT agent_command_receipts_connection_id_grant_id_fkey;
ALTER TABLE public.agent_command_receipts DROP CONSTRAINT agent_command_receipts_grant_generation_check;
ALTER TABLE public.agent_command_receipts DROP COLUMN grant_id;
ALTER TABLE public.agent_command_receipts DROP COLUMN grant_generation;
DROP TABLE public.agent_standing_grants;
