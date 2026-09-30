-- #154: preserve every existing human author/time/source; genuine agents stay agents.
ALTER TABLE project_conversations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE project_conversations ADD COLUMN created_by_agent_id uuid;
ALTER TABLE project_conversations ADD CONSTRAINT project_conversation_exact_actor
  CHECK (num_nonnulls(created_by, created_by_agent_id) = 1);
ALTER TABLE project_conversations ADD CONSTRAINT project_conversation_agent_workspace
  FOREIGN KEY (workspace_id, created_by_agent_id) REFERENCES agents(workspace_id, id);

ALTER TABLE project_messages ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE project_messages ADD COLUMN author_agent_id uuid;
ALTER TABLE project_messages ADD CONSTRAINT project_message_exact_actor
  CHECK (num_nonnulls(author_id, author_agent_id) = 1);
ALTER TABLE project_messages ADD CONSTRAINT project_message_agent_workspace
  FOREIGN KEY (workspace_id, author_agent_id) REFERENCES agents(workspace_id, id);
CREATE UNIQUE INDEX project_message_agent_command_idx
  ON project_messages(project_id, author_agent_id, client_message_id)
  WHERE author_agent_id IS NOT NULL;

-- Existing human search rows stay exact; only future inserts use the real actor.
CREATE OR REPLACE FUNCTION search_index_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('message:' || NEW.id, 'message', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text,
    NEW.conversation_id, NULL, NULL, '', NEW.body,
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END,
    coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;
