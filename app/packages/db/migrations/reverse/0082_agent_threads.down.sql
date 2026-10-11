-- The runner owns the schema ledger. Never discard a task's agent-thread history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_conversations WHERE space = 'agents') THEN
    RAISE EXCEPTION 'Cannot reverse 0082 while an agent thread exists';
  END IF;
END $$;
DROP TRIGGER agent_thread_agent_writes_closed ON project_messages;
DROP FUNCTION flux_guard_agent_thread_write();
DROP INDEX project_conversations_agent_work_idx;
ALTER TABLE project_conversations
  DROP CONSTRAINT project_conversations_agent_work_fk,
  DROP CONSTRAINT project_conversations_agent_work_check,
  DROP COLUMN work_id,
  DROP COLUMN space;
