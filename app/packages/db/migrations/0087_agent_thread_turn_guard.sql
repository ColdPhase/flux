-- #400: CLOSED internal native writer only. G2/public opening remains incomplete.
-- Provenance is content-free and append-only. The last event carries the task's counter;
-- deleting/editing a message cannot refund it, and an old boundary cannot reset it twice.
CREATE SEQUENCE agent_thread_guard_sequence;
CREATE TABLE agent_thread_guard_events (
  sequence bigint PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES project_conversations(id),
  message_id uuid NOT NULL UNIQUE REFERENCES project_messages(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('agent_message', 'human_message')),
  turn_count integer NOT NULL CHECK (turn_count BETWEEN 0 AND 5),
  author_agent_id uuid,
  connection_id uuid,
  client_command_id uuid,
  runtime_session_id uuid,
  grant_id uuid,
  transaction_id bigint NOT NULL,
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES project_work_items(workspace_id, project_id, id),
  FOREIGN KEY (connection_id, client_command_id) REFERENCES agent_command_receipts(connection_id, client_command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind = 'agent_message' AND author_agent_id IS NOT NULL AND connection_id IS NOT NULL
    AND client_command_id IS NOT NULL AND runtime_session_id IS NOT NULL AND grant_id IS NOT NULL)
    OR (kind = 'human_message' AND author_agent_id IS NULL AND connection_id IS NULL
      AND client_command_id IS NULL AND runtime_session_id IS NULL AND grant_id IS NULL))
);
CREATE INDEX agent_thread_guard_task_sequence ON agent_thread_guard_events(task_id, sequence DESC);
CREATE UNIQUE INDEX agent_thread_guard_command ON agent_thread_guard_events(connection_id, client_command_id)
  WHERE kind = 'agent_message';

CREATE FUNCTION flux_append_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  -- Native callers already retain the complete graph/task fence. Direct SQL cannot evade
  -- task serialization; sequence allocation occurs AFTER the lock, not before a wait.
  PERFORM 1 FROM project_work_items WHERE id = NEW.task_id AND workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id AND creation_reverted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM project_conversations WHERE id = NEW.conversation_id
    AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id AND space = 'agents' AND work_id = NEW.task_id) THEN
    RAISE EXCEPTION 'Invalid task-thread guard scope' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_scope';
  END IF;
  SELECT turn_count INTO previous FROM agent_thread_guard_events WHERE task_id = NEW.task_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.kind = 'agent_message' THEN
    IF COALESCE(previous, 0) >= 5 THEN
      RAISE EXCEPTION 'AGENT_THREAD_TURN_LIMIT' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_turn_limit';
    END IF;
    NEW.turn_count := COALESCE(previous, 0) + 1;
  ELSE
    -- Only the real AFTER INSERT human-message trigger may supply this boundary.
    -- No callable reset flag/GUC, old-message observation or fixture packet replenishes it.
    IF pg_trigger_depth() < 2 OR NOT EXISTS (SELECT 1 FROM project_messages WHERE id = NEW.message_id
      AND conversation_id = NEW.conversation_id AND workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id AND author_id IS NOT NULL AND author_agent_id IS NULL) THEN
      RAISE EXCEPTION 'Invalid human reset boundary' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_reset';
    END IF;
    NEW.turn_count := 0;
  END IF;
  NEW.sequence := nextval('agent_thread_guard_sequence');
  NEW.transaction_id := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_guard_append BEFORE INSERT ON agent_thread_guard_events
  FOR EACH ROW EXECUTE FUNCTION flux_append_agent_thread_guard();

CREATE FUNCTION flux_keep_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Task-thread guard provenance is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_immutable';
END $$;
CREATE TRIGGER agent_thread_guard_immutable BEFORE UPDATE OR DELETE ON agent_thread_guard_events
  FOR EACH ROW EXECUTE FUNCTION flux_keep_agent_thread_guard();

-- Guard metadata cannot be committed without its actual message and native receipt.
-- The application additionally performs the full live native authority and post-state checks.
CREATE FUNCTION flux_complete_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'agent_message' AND NOT EXISTS (
    SELECT 1 FROM project_messages m JOIN agent_command_receipts r
      ON r.connection_id = NEW.connection_id AND r.client_command_id = NEW.client_command_id
    JOIN agent_runtime_sessions runtime ON runtime.id = r.runtime_session_id AND runtime.connection_id = r.connection_id
    WHERE m.id = NEW.message_id AND m.author_agent_id = NEW.author_agent_id AND m.author_id IS NULL
      AND m.conversation_id = NEW.conversation_id AND m.project_id = NEW.project_id AND m.workspace_id = NEW.workspace_id
      AND runtime.agent_id = NEW.author_agent_id AND runtime.workspace_id = NEW.workspace_id
      AND r.runtime_session_id = NEW.runtime_session_id AND r.grant_id = NEW.grant_id
      AND r.operation = 'conversation.reply' AND r.project_id = NEW.project_id
      AND r.value->>'taskId' = NEW.task_id::text AND r.value->>'conversationId' = NEW.conversation_id::text
      AND r.value->>'messageId' = NEW.message_id::text
      AND r.postconditions @> jsonb_build_array(jsonb_build_object('kind', 'message', 'id', NEW.message_id::text))
  ) THEN
    RAISE EXCEPTION 'Incomplete native task-thread receipt' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_receipt';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER agent_thread_guard_receipt AFTER INSERT ON agent_thread_guard_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flux_complete_agent_thread_guard();

CREATE OR REPLACE FUNCTION flux_guard_agent_thread_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_conversations WHERE id = NEW.conversation_id AND space = 'agents')
    AND (TG_OP <> 'INSERT' OR NOT EXISTS (SELECT 1 FROM agent_thread_guard_events g
      WHERE g.message_id = NEW.id AND g.kind = 'agent_message' AND g.transaction_id = txid_current()
        AND g.author_agent_id = NEW.author_agent_id AND g.conversation_id = NEW.conversation_id
        AND g.workspace_id = NEW.workspace_id AND g.project_id = NEW.project_id)) THEN
    RAISE EXCEPTION 'Agent-thread agent writes require the verified internal native guard'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_agent_writes_closed';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION flux_agent_thread_human_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE thread project_conversations%ROWTYPE;
BEGIN
  SELECT * INTO thread FROM project_conversations WHERE id = NEW.conversation_id AND space = 'agents';
  IF FOUND AND NEW.author_id IS NOT NULL AND EXISTS (SELECT 1 FROM agent_thread_guard_events WHERE task_id = thread.work_id) THEN
    INSERT INTO agent_thread_guard_events(workspace_id, project_id, task_id, conversation_id, message_id, kind, turn_count, transaction_id)
      VALUES(thread.workspace_id, thread.project_id, thread.work_id, thread.id, NEW.id, 'human_message', 0, txid_current());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_thread_human_boundary AFTER INSERT ON project_messages
  FOR EACH ROW EXECUTE FUNCTION flux_agent_thread_human_boundary();

CREATE FUNCTION flux_keep_agent_thread_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'project_conversations' THEN
    IF (OLD.space = 'agents' OR NEW.space = 'agents') AND
      ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.space, OLD.work_id) IS DISTINCT FROM
      ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.space, NEW.work_id) THEN
      RAISE EXCEPTION 'Task-thread binding is immutable' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_identity';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM agent_thread_guard_events WHERE conversation_id = OLD.conversation_id
    OR (TG_OP = 'UPDATE' AND conversation_id = NEW.conversation_id)) THEN
    IF TG_OP = 'DELETE' OR ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.conversation_id, OLD.author_id, OLD.author_agent_id, OLD.client_message_id)
      IS DISTINCT FROM ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.conversation_id, NEW.author_id, NEW.author_agent_id, NEW.client_message_id) THEN
      RAISE EXCEPTION 'Task-thread message identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_identity';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_binding_immutable BEFORE UPDATE ON project_conversations
  FOR EACH ROW EXECUTE FUNCTION flux_keep_agent_thread_identity();
CREATE TRIGGER agent_thread_message_immutable BEFORE UPDATE OR DELETE ON project_messages
  FOR EACH ROW EXECUTE FUNCTION flux_keep_agent_thread_identity();
