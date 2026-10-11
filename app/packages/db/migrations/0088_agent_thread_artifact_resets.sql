-- #400 accepted canonical artifact resets. Production agent-thread writers remain CLOSED.
-- Retain 0087's native/human provenance; new boundaries never rewrite its history.
CREATE TABLE agent_thread_artifact_boundaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('doc','material','result','decision','thought','github_pr','file')),
  source_id text NOT NULL,
  revision text NOT NULL,
  content_identity text,
  transaction_id bigint NOT NULL,
  UNIQUE(kind, source_id, revision),
  FOREIGN KEY(workspace_id, project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE agent_thread_artifact_resets (
  task_id uuid NOT NULL,
  boundary_id uuid NOT NULL REFERENCES agent_thread_artifact_boundaries(id),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence bigint,
  content_identity text,
  PRIMARY KEY(task_id,boundary_id),
  FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES project_work_items(workspace_id,project_id,id)
);
CREATE UNIQUE INDEX agent_thread_file_consumed_bytes ON agent_thread_artifact_resets(task_id,content_identity)
  WHERE content_identity IS NOT NULL;
CREATE INDEX agent_thread_artifact_task_sequence ON agent_thread_artifact_resets(task_id,sequence DESC) WHERE sequence IS NOT NULL;

-- Existing canonical versions are historical boundaries, never new progress after upgrade.
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT v.workspace_id,v.project_id,m.kind,v.material_id::text,v.version::text,txid_current()
  FROM project_material_versions v JOIN project_materials m ON m.id=v.material_id;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT workspace_id,project_id,'result',id::text,'created',txid_current() FROM project_results;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT workspace_id,project_id,'decision',id::text,version::text || ':' || status,txid_current() FROM project_decisions;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT t.workspace_id,s.project_id,'thought',t.id::text,n.revision::text,txid_current()
  FROM sketch_thoughts t JOIN sketches s ON s.id=t.sketch_id
  CROSS JOIN LATERAL (SELECT 1 AS revision UNION SELECT t.version) n WHERE s.scope='project';
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,content_identity,transaction_id)
  SELECT workspace_id,project_id,'file',id::text,'published',sha256 || ':' || size::text,txid_current()
  FROM project_files WHERE published_at IS NOT NULL AND replay_of IS NULL;

-- Upgrade records consumed old bytes without a sequence, so it does NOT reset an existing budget.
INSERT INTO agent_thread_artifact_resets(task_id,boundary_id,workspace_id,project_id,content_identity)
  SELECT DISTINCT task.id,b.id,f.workspace_id,f.project_id,b.content_identity
  FROM project_files f JOIN agent_thread_artifact_boundaries b ON b.kind='file' AND b.source_id=f.id::text
  JOIN project_messages m ON m.id=f.message_id
  JOIN project_conversations c ON c.id=m.conversation_id
  LEFT JOIN project_task_discussions discussion ON discussion.conversation_id=c.id
  JOIN project_work_items task ON task.id=COALESCE(c.work_id,discussion.work_id)
    AND task.workspace_id=f.workspace_id AND task.project_id=f.project_id AND task.creation_reverted_at IS NULL
  ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_resets(task_id,boundary_id,workspace_id,project_id,content_identity)
  SELECT DISTINCT task.id,b.id,f.workspace_id,f.project_id,b.content_identity
  FROM project_files f JOIN agent_thread_artifact_boundaries b ON b.kind='file' AND b.source_id=f.id::text
  JOIN sketch_thoughts thought ON thought.id=f.thought_id JOIN sketches s ON s.id=thought.sketch_id AND s.scope='project'
  JOIN project_object_links l ON l.from_type='work' AND l.to_type='thought' AND l.to_id=thought.id AND l.role IN ('source','related')
    AND l.workspace_id=f.workspace_id AND l.project_id=f.project_id
  JOIN project_work_items task ON task.id=l.from_id AND task.workspace_id=f.workspace_id
    AND task.project_id=f.project_id AND task.creation_reverted_at IS NULL
  ON CONFLICT DO NOTHING;

CREATE FUNCTION flux_append_artifact_reset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary agent_thread_artifact_boundaries%ROWTYPE;
BEGIN
  SELECT * INTO boundary FROM agent_thread_artifact_boundaries WHERE id=NEW.boundary_id;
  IF NOT FOUND OR boundary.workspace_id<>NEW.workspace_id OR boundary.project_id<>NEW.project_id
    OR boundary.transaction_id<>txid_current() THEN
    RAISE EXCEPTION 'An old or foreign artifact boundary cannot reset a task'
      USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_boundary';
  END IF;
  PERFORM 1 FROM project_work_items WHERE id=NEW.task_id AND workspace_id=NEW.workspace_id
    AND project_id=NEW.project_id AND creation_reverted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid artifact reset task' USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_scope'; END IF;
  NEW.sequence:=nextval('agent_thread_guard_sequence');
  NEW.content_identity:=CASE WHEN boundary.kind='file' THEN boundary.content_identity ELSE NULL END;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_artifact_reset_append BEFORE INSERT ON agent_thread_artifact_resets
  FOR EACH ROW EXECUTE FUNCTION flux_append_artifact_reset();
CREATE FUNCTION flux_artifact_xid_is_current(source_xid xid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid'
    AND mode='ExclusiveLock' AND transactionid=source_xid)
$$;
CREATE FUNCTION flux_verify_artifact_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean:=false;
BEGIN
  IF NEW.kind IN ('doc','material') THEN
    SELECT EXISTS(SELECT 1 FROM project_material_versions v JOIN project_materials m ON m.id=v.material_id
      WHERE v.material_id::text=NEW.source_id AND v.version::text=NEW.revision AND m.kind=NEW.kind
        AND v.workspace_id=NEW.workspace_id AND v.project_id=NEW.project_id AND flux_artifact_xid_is_current(v.xmin)) INTO fresh;
  ELSIF NEW.kind='result' THEN
    SELECT EXISTS(SELECT 1 FROM project_results r WHERE r.id::text=NEW.source_id AND NEW.revision='created'
      AND r.workspace_id=NEW.workspace_id AND r.project_id=NEW.project_id AND flux_artifact_xid_is_current(r.xmin)) INTO fresh;
  ELSIF NEW.kind='decision' THEN
    SELECT EXISTS(SELECT 1 FROM project_decisions d WHERE d.id::text=NEW.source_id AND d.version::text || ':' || d.status=NEW.revision
      AND d.workspace_id=NEW.workspace_id AND d.project_id=NEW.project_id AND flux_artifact_xid_is_current(d.xmin)) INTO fresh;
  ELSIF NEW.kind='thought' THEN
    SELECT EXISTS(SELECT 1 FROM sketch_thoughts t JOIN sketches s ON s.id=t.sketch_id WHERE t.id::text=NEW.source_id
      AND t.version::text=NEW.revision AND s.scope='project' AND t.workspace_id=NEW.workspace_id AND s.project_id=NEW.project_id
      AND flux_artifact_xid_is_current(t.xmin)) INTO fresh;
  ELSIF NEW.kind='file' THEN
    SELECT EXISTS(SELECT 1 FROM project_files f WHERE f.id::text=NEW.source_id AND NEW.revision='published'
      AND f.workspace_id=NEW.workspace_id AND f.project_id=NEW.project_id AND f.state='ready'
      AND f.published_at IS NOT NULL AND f.replay_of IS NULL AND f.sha256 || ':' || f.size::text=NEW.content_identity
      AND flux_artifact_xid_is_current(f.xmin)) INTO fresh;
  ELSIF NEW.kind='github_pr' THEN
    SELECT EXISTS(SELECT 1 FROM github_task_links l JOIN github_bindings b ON b.id=l.binding_id
      WHERE l.binding_id::text || ':' || b.repository_id || ':' || l.pull_id || ':' || l.task_id::text=NEW.source_id
      AND l.workspace_id=NEW.workspace_id AND l.project_id=NEW.project_id AND l.state='current'
      AND b.state='active' AND l.facts->>'headSha'=NEW.revision AND flux_artifact_xid_is_current(l.xmin)) INTO fresh;
  END IF;
  IF NOT fresh THEN RAISE EXCEPTION 'A fresh canonical artifact mutation is required'
    USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_canonical'; END IF;
  NEW.transaction_id:=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_artifact_canonical BEFORE INSERT ON agent_thread_artifact_boundaries
  FOR EACH ROW EXECUTE FUNCTION flux_verify_artifact_boundary();
CREATE TRIGGER agent_thread_artifact_boundary_immutable BEFORE UPDATE OR DELETE ON agent_thread_artifact_boundaries
  FOR EACH ROW EXECUTE FUNCTION flux_keep_agent_thread_guard();
CREATE TRIGGER agent_thread_artifact_reset_immutable BEFORE UPDATE OR DELETE ON agent_thread_artifact_resets
  FOR EACH ROW EXECUTE FUNCTION flux_keep_agent_thread_guard();

CREATE OR REPLACE FUNCTION flux_append_agent_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  PERFORM 1 FROM project_work_items WHERE id=NEW.task_id AND workspace_id=NEW.workspace_id
    AND project_id=NEW.project_id AND creation_reverted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM project_conversations WHERE id=NEW.conversation_id
    AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND space='agents' AND work_id=NEW.task_id) THEN
    RAISE EXCEPTION 'Invalid task-thread guard scope' USING ERRCODE='23514',CONSTRAINT='agent_thread_guard_scope';
  END IF;
  SELECT turn_count INTO previous FROM (
    SELECT sequence,turn_count FROM agent_thread_guard_events WHERE task_id=NEW.task_id
    UNION ALL SELECT sequence,0 FROM agent_thread_artifact_resets WHERE task_id=NEW.task_id AND sequence IS NOT NULL
  ) boundaries ORDER BY sequence DESC LIMIT 1;
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
