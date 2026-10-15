-- Retained native messages/receipts need their guard provenance permanently.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_thread_guard_events WHERE kind = 'agent_message') THEN
    RAISE EXCEPTION 'Cannot reverse 0087 after a guarded native message';
  END IF;
END $$;
DROP TRIGGER agent_thread_binding_immutable ON project_conversations;
DROP TRIGGER agent_thread_message_immutable ON project_messages;
DROP TRIGGER agent_thread_human_boundary ON project_messages;
DROP FUNCTION flux_keep_agent_thread_identity();
DROP FUNCTION flux_agent_thread_human_boundary();
DROP TABLE agent_thread_guard_events;
DROP SEQUENCE agent_thread_guard_sequence;
DROP FUNCTION flux_complete_agent_thread_guard();
DROP FUNCTION flux_keep_agent_thread_guard();
DROP FUNCTION flux_append_agent_thread_guard();
CREATE OR REPLACE FUNCTION flux_guard_agent_thread_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_conversations WHERE id = NEW.conversation_id AND space = 'agents') THEN
    RAISE EXCEPTION 'Agent-thread agent writes require the verified turn guard'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_agent_writes_closed';
  END IF;
  RETURN NEW;
END $$;
