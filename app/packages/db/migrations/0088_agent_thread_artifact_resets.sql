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

-- Content-free witnesses capture actual before/after deltas. An incorrect producer cannot
-- turn a fresh title/geometry/no-op tuple into progress merely by choosing a boundary key.
CREATE TABLE agent_thread_artifact_mutations (
  kind text NOT NULL,source_id text NOT NULL,revision text NOT NULL,
  workspace_id uuid NOT NULL,project_id uuid NOT NULL,transaction_id bigint NOT NULL,
  progress boolean NOT NULL,
  PRIMARY KEY(kind,source_id,revision,transaction_id)
);
CREATE FUNCTION flux_protect_artifact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()<2 OR TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Artifact witnesses come only from canonical row mutations'
      USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_witness';
  END IF;
  NEW.transaction_id:=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER agent_thread_artifact_witness_protected BEFORE INSERT OR UPDATE OR DELETE ON agent_thread_artifact_mutations
  FOR EACH ROW EXECUTE FUNCTION flux_protect_artifact_mutation();
CREATE FUNCTION flux_capture_artifact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE artifact_kind text;source text;revision_key text;workspace uuid;project uuid;changed boolean;
  previous project_material_versions%ROWTYPE; map sketches%ROWTYPE; binding github_bindings%ROWTYPE;
BEGIN
  workspace:=NEW.workspace_id;
  IF TG_TABLE_NAME='project_material_versions' THEN
    project:=NEW.project_id;source:=NEW.material_id::text;revision_key:=NEW.version::text;
    SELECT kind INTO artifact_kind FROM project_materials WHERE id=NEW.material_id;
    SELECT * INTO previous FROM project_material_versions WHERE material_id=NEW.material_id AND version=NEW.version-1;
    changed:=NOT FOUND OR NEW.body IS DISTINCT FROM previous.body OR NEW.url IS DISTINCT FROM previous.url
      OR (artifact_kind='doc' AND COALESCE(NEW.state,'published') IS DISTINCT FROM COALESCE(previous.state,'published'));
  ELSIF TG_TABLE_NAME='project_results' THEN
    artifact_kind:='result';source:=NEW.id::text;revision_key:='created';project:=NEW.project_id;changed:=true;
  ELSIF TG_TABLE_NAME='project_decisions' THEN
    artifact_kind:='decision';source:=NEW.id::text;revision_key:=NEW.version::text || ':' || NEW.status;project:=NEW.project_id;
    changed:=TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status;
  ELSIF TG_TABLE_NAME='sketch_thoughts' THEN
    SELECT * INTO map FROM sketches WHERE id=NEW.sketch_id;
    IF map.scope<>'project' OR map.project_id IS NULL THEN RETURN NULL; END IF;
    artifact_kind:='thought';source:=NEW.id::text;revision_key:=NEW.version::text;project:=map.project_id;
    changed:=TG_OP='INSERT' OR NEW.text IS DISTINCT FROM OLD.text;
  ELSIF TG_TABLE_NAME='project_files' THEN
    artifact_kind:='file';source:=NEW.id::text;revision_key:='published';project:=NEW.project_id;
    changed:=OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.state='ready' AND NEW.replay_of IS NULL;
  ELSE
    SELECT * INTO binding FROM github_bindings WHERE id=NEW.binding_id;
    artifact_kind:='github_pr';source:=NEW.binding_id::text || ':' || binding.repository_id || ':' || NEW.pull_id || ':' || NEW.task_id::text;
    revision_key:=NEW.facts->>'headSha';project:=NEW.project_id;
    changed:=NEW.state='current' AND binding.state='active' AND revision_key~'^[0-9a-f]{40}([0-9a-f]{24})?$'
      AND (TG_OP='INSERT' OR NEW.facts->>'headSha' IS DISTINCT FROM OLD.facts->>'headSha');
  END IF;
  -- No-op/geometry/status-only and missing/unverified PR heads have no witness.
  IF changed IS DISTINCT FROM true THEN RETURN NULL; END IF;
  INSERT INTO agent_thread_artifact_mutations(kind,source_id,revision,workspace_id,project_id,transaction_id,progress)
    VALUES(artifact_kind,source,revision_key,workspace,project,txid_current(),changed)
    ON CONFLICT(kind,source_id,revision,transaction_id) DO UPDATE
      SET progress=agent_thread_artifact_mutations.progress OR EXCLUDED.progress;
  RETURN NULL;
END $$;
CREATE TRIGGER artifact_material_delta AFTER INSERT ON project_material_versions FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_result_delta AFTER INSERT ON project_results FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_decision_delta AFTER INSERT OR UPDATE ON project_decisions FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_thought_delta AFTER INSERT OR UPDATE ON sketch_thoughts FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_file_delta AFTER UPDATE ON project_files FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_pr_delta AFTER INSERT OR UPDATE ON github_task_links FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();

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
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT l.workspace_id,l.project_id,'github_pr',l.binding_id::text || ':' || b.repository_id || ':' || l.pull_id || ':' || l.task_id::text,
    l.facts->>'headSha',txid_current() FROM github_task_links l JOIN github_bindings b ON b.id=l.binding_id
  WHERE l.facts->>'headSha'~'^[0-9a-f]{40}([0-9a-f]{24})?$';

-- Upgrade records consumed old bytes without a sequence, so it does NOT reset an existing budget.
INSERT INTO agent_thread_artifact_resets(task_id,boundary_id,workspace_id,project_id,content_identity)
  SELECT DISTINCT task.id,b.id,f.workspace_id,f.project_id,b.content_identity
  FROM project_files f JOIN agent_thread_artifact_boundaries b ON b.kind='file' AND b.source_id=f.id::text
  JOIN project_messages m ON m.id=f.message_id
  JOIN project_conversations c ON c.id=m.conversation_id
  LEFT JOIN project_task_discussions discussion ON discussion.conversation_id=c.id
  JOIN project_work_items task ON task.id=COALESCE(c.work_id,discussion.work_id)
    AND task.workspace_id=f.workspace_id AND task.project_id=f.project_id
  WHERE m.workspace_id=f.workspace_id AND m.project_id=f.project_id AND c.workspace_id=f.workspace_id AND c.project_id=f.project_id
  ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_resets(task_id,boundary_id,workspace_id,project_id,content_identity)
  SELECT DISTINCT task.id,b.id,f.workspace_id,f.project_id,b.content_identity
  FROM project_files f JOIN agent_thread_artifact_boundaries b ON b.kind='file' AND b.source_id=f.id::text
  JOIN sketch_thoughts thought ON thought.id=f.thought_id AND thought.workspace_id=f.workspace_id
  JOIN sketches s ON s.id=thought.sketch_id AND s.scope='project' AND s.workspace_id=f.workspace_id AND s.project_id=f.project_id
  JOIN project_object_links l ON l.from_type='work' AND l.to_type='thought' AND l.to_id=thought.id AND l.role IN ('source','related')
    AND l.workspace_id=f.workspace_id AND l.project_id=f.project_id
  JOIN project_work_items task ON task.id=l.from_id AND task.workspace_id=f.workspace_id
    AND task.project_id=f.project_id
  ON CONFLICT DO NOTHING;

CREATE FUNCTION flux_artifact_task_is_direct(task uuid,boundary agent_thread_artifact_boundaries) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF boundary.kind IN ('doc','material') THEN RETURN EXISTS(SELECT 1 FROM project_object_links l
    WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND (
      (l.from_type='work' AND l.from_id=task AND l.to_id::text=boundary.source_id AND l.role IN ('source','related')
        AND ((l.to_type='doc' AND boundary.kind='doc') OR(l.to_type='material' AND(l.to_version IS NULL OR l.to_version::text=boundary.revision))))
      OR(boundary.kind='doc' AND l.from_type='doc' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role IN('mentions','source'))));
  ELSIF boundary.kind='result' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.from_type='result' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role='about');
  ELSIF boundary.kind='decision' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.from_type='decision' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role IN('affects','still_applies'));
  ELSIF boundary.kind='thought' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l JOIN sketch_thoughts t ON t.id=l.to_id JOIN sketches s ON s.id=t.sketch_id
    WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND l.from_type='work' AND l.from_id=task AND l.to_type='thought'
      AND l.to_id::text=boundary.source_id AND l.role IN('source','related') AND t.workspace_id=boundary.workspace_id AND s.project_id=boundary.project_id AND s.scope='project');
  ELSIF boundary.kind='file' THEN RETURN EXISTS(SELECT 1 FROM project_files f LEFT JOIN project_messages m ON m.id=f.message_id
    LEFT JOIN project_conversations c ON c.id=m.conversation_id LEFT JOIN project_task_discussions d ON d.conversation_id=c.id
    LEFT JOIN sketch_thoughts t ON t.id=f.thought_id LEFT JOIN sketches s ON s.id=t.sketch_id
    WHERE f.id::text=boundary.source_id AND f.workspace_id=boundary.workspace_id AND f.project_id=boundary.project_id AND(
      (COALESCE(c.work_id,d.work_id)=task AND m.project_id=boundary.project_id AND m.workspace_id=boundary.workspace_id AND c.project_id=boundary.project_id AND c.workspace_id=boundary.workspace_id)
      OR(s.scope='project' AND s.project_id=boundary.project_id AND s.workspace_id=boundary.workspace_id AND EXISTS(SELECT 1 FROM project_object_links l
        WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND l.from_type='work' AND l.from_id=task AND l.to_type='thought' AND l.to_id=t.id AND l.role IN('source','related')))));
  ELSE RETURN EXISTS(SELECT 1 FROM github_task_links l JOIN github_bindings b ON b.id=l.binding_id WHERE l.task_id=task AND l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.binding_id::text || ':' || b.repository_id || ':' || l.pull_id || ':' || l.task_id::text=boundary.source_id AND l.facts->>'headSha'=boundary.revision AND l.state='current' AND b.state='active');
  END IF;
END $$;
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
  IF NOT flux_artifact_task_is_direct(NEW.task_id,boundary) THEN
    RAISE EXCEPTION 'The task is not a direct eligible artifact recipient'
      USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_association';
  END IF;
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
  -- This frozen batch installs doc/material/result/decision producers only.
  -- History support cannot admit a new boundary for an uninstalled producer.
  IF NEW.kind IN('thought','file','github_pr') THEN
    RAISE EXCEPTION 'This artifact reset producer is not installed'
      USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_producer_closed';
  END IF;
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
  IF NOT fresh OR NOT EXISTS(SELECT 1 FROM agent_thread_artifact_mutations w
    WHERE w.kind=NEW.kind AND w.source_id=NEW.source_id AND w.revision=NEW.revision
      AND w.workspace_id=NEW.workspace_id AND w.project_id=NEW.project_id AND w.transaction_id=txid_current() AND w.progress) THEN
    RAISE EXCEPTION 'A fresh canonical artifact mutation with actual progress is required'
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
