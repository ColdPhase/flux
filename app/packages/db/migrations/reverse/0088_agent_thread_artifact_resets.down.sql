DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM agent_thread_artifact_resets WHERE sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0088 after an artifact reset';
  END IF;
END $$;
DROP TABLE agent_thread_artifact_resets;
DROP FUNCTION flux_append_artifact_reset();
DROP FUNCTION flux_artifact_task_is_direct(uuid,agent_thread_artifact_boundaries);
DROP TABLE agent_thread_artifact_boundaries;
DROP FUNCTION flux_verify_artifact_boundary();
DROP FUNCTION flux_artifact_xid_is_current(xid);
DROP TRIGGER artifact_material_delta ON project_material_versions;
DROP TRIGGER artifact_result_delta ON project_results;
DROP TRIGGER artifact_decision_delta ON project_decisions;
DROP TRIGGER artifact_thought_delta ON sketch_thoughts;
DROP TRIGGER artifact_file_delta ON project_files;
DROP TRIGGER artifact_pr_delta ON github_task_links;
DROP FUNCTION flux_capture_artifact_mutation();
DROP TABLE agent_thread_artifact_mutations;
DROP FUNCTION flux_protect_artifact_mutation();
CREATE OR REPLACE FUNCTION flux_append_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  PERFORM 1 FROM project_work_items WHERE id=NEW.task_id AND workspace_id=NEW.workspace_id
    AND project_id=NEW.project_id AND creation_reverted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM project_conversations WHERE id=NEW.conversation_id
    AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND space='agents' AND work_id=NEW.task_id) THEN
    RAISE EXCEPTION 'Invalid task-thread guard scope' USING ERRCODE='23514',CONSTRAINT='agent_thread_guard_scope';
  END IF;
  SELECT turn_count INTO previous FROM agent_thread_guard_events WHERE task_id=NEW.task_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.kind='agent_message' THEN
    IF COALESCE(previous,0)>=5 THEN RAISE EXCEPTION 'AGENT_THREAD_TURN_LIMIT' USING ERRCODE='23514',CONSTRAINT='agent_thread_turn_limit'; END IF;
    NEW.turn_count:=COALESCE(previous,0)+1;
  ELSE
    IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM project_messages WHERE id=NEW.message_id
      AND conversation_id=NEW.conversation_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id
      AND author_id IS NOT NULL AND author_agent_id IS NULL) THEN
      RAISE EXCEPTION 'Invalid human reset boundary' USING ERRCODE='23514',CONSTRAINT='agent_thread_guard_reset';
    END IF;
    NEW.turn_count:=0;
  END IF;
  NEW.sequence:=nextval('agent_thread_guard_sequence');NEW.transaction_id:=txid_current();RETURN NEW;
END $$;
