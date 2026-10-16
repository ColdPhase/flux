-- #530: erasure follows ownership. Agent-thread rows and their content-free provenance leave
-- only together with their owner. While the owner exists they stay immutable, as before:
--   project: artifact boundaries and mutation witnesses, and everything below;
--   task:    its agent thread (conversation and messages), guard events and artifact resets.
-- There is no separate expiry (docs/product/cowork-workflow.md, CW-2 "Retention"). Only the
-- tables and triggers of 0082/0087/0088/0089 change; other project tables keep their own rules.

-- A delete is admitted only when the owner is already gone in this statement, i.e. a cascade.
-- Updates, and deletes while the owner exists, raise exactly as before.
CREATE OR REPLACE FUNCTION flux_keep_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND workspace_id = OLD.workspace_id) THEN RETURN OLD; END IF;
    -- Guard events and resets belong to their task; boundaries have no task.
    IF TG_TABLE_NAME <> 'agent_thread_artifact_boundaries' THEN
      IF NOT EXISTS (SELECT 1 FROM project_work_items WHERE id = OLD.task_id) THEN RETURN OLD; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Task-thread guard provenance is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_immutable';
END $$;

CREATE OR REPLACE FUNCTION flux_protect_artifact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND workspace_id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF pg_trigger_depth()<2 OR TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Artifact witnesses come only from canonical row mutations'
      USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_witness';
  END IF;
  NEW.transaction_id:=txid_current();RETURN NEW;
END $$;

-- Thread messages may go with their deleted thread. Removing the thread alone still fails:
-- its guard events refuse while the task exists, so no erasure refunds a task's turns.
CREATE OR REPLACE FUNCTION flux_keep_agent_thread_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'project_conversations' THEN
    IF (OLD.space = 'agents' OR NEW.space = 'agents') AND
      ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.space, OLD.work_id) IS DISTINCT FROM
      ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.space, NEW.work_id) THEN
      RAISE EXCEPTION 'Task-thread binding is immutable' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_identity';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM agent_thread_guard_events WHERE conversation_id = OLD.conversation_id
    OR (TG_OP = 'UPDATE' AND conversation_id = NEW.conversation_id)) THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM project_conversations WHERE id = OLD.conversation_id) THEN RETURN OLD; END IF;
    IF TG_OP = 'DELETE' OR ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.conversation_id, OLD.author_id, OLD.author_agent_id, OLD.client_message_id)
      IS DISTINCT FROM ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.conversation_id, NEW.author_id, NEW.author_agent_id, NEW.client_message_id) THEN
      RAISE EXCEPTION 'Task-thread message identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'agent_thread_guard_identity';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- Every path from a project or task to these rows cascades, so no check depends on cascade order.
ALTER TABLE agent_thread_artifact_boundaries
  DROP CONSTRAINT agent_thread_artifact_boundaries_workspace_id_project_id_fkey,
  ADD CONSTRAINT agent_thread_artifact_boundaries_workspace_id_project_id_fkey FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE agent_thread_artifact_resets
  DROP CONSTRAINT agent_thread_artifact_resets_boundary_id_fkey,
  DROP CONSTRAINT agent_thread_artifact_resets_workspace_id_project_id_task__fkey,
  ADD CONSTRAINT agent_thread_artifact_resets_boundary_id_fkey FOREIGN KEY (boundary_id)
    REFERENCES agent_thread_artifact_boundaries(id) ON DELETE CASCADE,
  ADD CONSTRAINT agent_thread_artifact_resets_workspace_id_project_id_task__fkey FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE;
ALTER TABLE agent_thread_guard_events
  DROP CONSTRAINT agent_thread_guard_events_conversation_id_fkey,
  DROP CONSTRAINT agent_thread_guard_events_message_id_fkey,
  DROP CONSTRAINT agent_thread_guard_events_workspace_id_project_id_task_id_fkey,
  ADD CONSTRAINT agent_thread_guard_events_conversation_id_fkey FOREIGN KEY (conversation_id)
    REFERENCES project_conversations(id) ON DELETE CASCADE,
  ADD CONSTRAINT agent_thread_guard_events_message_id_fkey FOREIGN KEY (message_id)
    REFERENCES project_messages(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT agent_thread_guard_events_workspace_id_project_id_task_id_fkey FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE;
ALTER TABLE project_conversations
  DROP CONSTRAINT project_conversations_agent_work_fk,
  ADD CONSTRAINT project_conversations_agent_work_fk FOREIGN KEY (workspace_id, project_id, work_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE;

-- Witnesses had no owner key. Those of projects erased before this migration are dropped by the rule above.
DELETE FROM agent_thread_artifact_mutations m
  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = m.project_id AND p.workspace_id = m.workspace_id);
ALTER TABLE agent_thread_artifact_mutations
  ADD CONSTRAINT agent_thread_artifact_mutations_workspace_id_project_id_fkey FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE;

-- 0087's identity trigger looks up guard events by conversation on every message update or delete.
CREATE INDEX agent_thread_guard_conversation ON agent_thread_guard_events(conversation_id);
-- A cascading boundary delete finds its resets without scanning the table.
CREATE INDEX agent_thread_artifact_reset_boundary ON agent_thread_artifact_resets(boundary_id);
