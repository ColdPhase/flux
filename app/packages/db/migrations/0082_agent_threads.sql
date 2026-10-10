-- #400 / accepted F-018 CW-2: one task agent thread, with the task's exact audience.
-- Existing conversations and their history remain in the people space.
ALTER TABLE project_conversations
  ADD COLUMN space text NOT NULL DEFAULT 'people' CHECK (space IN ('people', 'agents')),
  ADD COLUMN work_id uuid,
  ADD CONSTRAINT project_conversations_agent_work_check CHECK ((space = 'agents') = (work_id IS NOT NULL)),
  ADD CONSTRAINT project_conversations_agent_work_fk FOREIGN KEY (workspace_id, project_id, work_id)
    REFERENCES project_work_items(workspace_id, project_id, id);

CREATE UNIQUE INDEX project_conversations_agent_work_idx ON project_conversations(work_id) WHERE space = 'agents';

-- The first increment has no verified five-turn/reset adapter. Keep EVERY agent writer to
-- this new space closed, including generic replies, questions and other contribution paths.
-- People-space behavior and stored historical agent messages are unchanged. Only a separately
-- accepted, tested turn guard can replace this barrier before agent writes become reachable.
CREATE FUNCTION flux_guard_agent_thread_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM project_conversations WHERE id = NEW.conversation_id AND space = 'agents'
  ) THEN
    RAISE EXCEPTION 'Agent-thread agent writes require the verified turn guard'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_agent_writes_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_agent_writes_closed
  BEFORE INSERT OR UPDATE OF author_agent_id, conversation_id ON project_messages
  FOR EACH ROW EXECUTE FUNCTION flux_guard_agent_thread_write();
