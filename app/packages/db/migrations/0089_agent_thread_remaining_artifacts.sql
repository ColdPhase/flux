-- #400 accepted remaining canonical producers. Existing0088 and its reverse are retained.
-- NOWAIT prevents a half-acquired migration fence from waiting on an in-flight writer.
-- The supported migration transaction remains atomic; a busy operator retries after quiescing it.
LOCK TABLE sketches, project_files, project_material_versions, project_results, project_decisions,
  github_bindings, project_messages, project_conversations, project_task_discussions,
  project_object_links, project_work_items, sketch_thoughts, github_task_links,
  agent_thread_artifact_mutations, agent_thread_artifact_boundaries, agent_thread_artifact_resets
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
ALTER TABLE agent_thread_artifact_boundaries DISABLE TRIGGER agent_thread_artifact_canonical;
ALTER TABLE agent_thread_artifact_resets DISABLE TRIGGER agent_thread_artifact_reset_append;

-- Protected witnesses retain actual historical revisions, including a deleted/recreated thought.
-- No reset/use/thread effect is inferred from an upgrade or an old association.
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,content_identity,transaction_id)
SELECT m.workspace_id,m.project_id,m.kind,m.source_id,m.revision,
  CASE WHEN m.kind='file' THEN f.sha256 || ':' || f.size::text ELSE NULL END,txid_current()
FROM agent_thread_artifact_mutations m JOIN projects p ON p.id=m.project_id AND p.workspace_id=m.workspace_id
LEFT JOIN project_files f ON m.kind='file' AND f.id::text=m.source_id AND f.project_id=m.project_id AND f.workspace_id=m.workspace_id
WHERE m.progress ORDER BY m.kind,m.source_id,m.revision,m.transaction_id
ON CONFLICT DO NOTHING;

-- Existing canonical versions are historical boundaries, never new progress after upgrade.
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT v.workspace_id,v.project_id,m.kind,v.material_id::text,v.version::text,txid_current()
  FROM project_material_versions v JOIN project_materials m ON m.id=v.material_id
ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT workspace_id,project_id,'result',id::text,'created',txid_current() FROM project_results
ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT workspace_id,project_id,'decision',id::text,version::text || ':' || status,txid_current() FROM project_decisions
ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT t.workspace_id,s.project_id,'thought',t.id::text,n.revision::text,txid_current()
  FROM sketch_thoughts t JOIN sketches s ON s.id=t.sketch_id
  CROSS JOIN LATERAL (SELECT 1 AS revision UNION SELECT t.version) n WHERE s.scope='project'
ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,content_identity,transaction_id)
  SELECT workspace_id,project_id,'file',id::text,'published',sha256 || ':' || size::text,txid_current()
  FROM project_files WHERE published_at IS NOT NULL AND replay_of IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
  SELECT l.workspace_id,l.project_id,'github_pr',l.binding_id::text || ':' || b.repository_id || ':' || l.pull_id || ':' || l.task_id::text,
    l.facts->>'headSha',txid_current() FROM github_task_links l JOIN github_bindings b ON b.id=l.binding_id
  WHERE l.facts->>'headSha'~'^[0-9a-f]{40}([0-9a-f]{24})?$'
ON CONFLICT DO NOTHING;

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
  ORDER BY task.id,b.id
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
  ORDER BY task.id,b.id
  ON CONFLICT DO NOTHING;

ALTER TABLE agent_thread_artifact_resets ENABLE TRIGGER agent_thread_artifact_reset_append;
ALTER TABLE agent_thread_artifact_boundaries ENABLE TRIGGER agent_thread_artifact_canonical;

CREATE OR REPLACE FUNCTION flux_verify_artifact_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND b.workspace_id=NEW.workspace_id AND b.project_id=NEW.project_id
      AND b.state='active' AND l.facts->>'headSha'=NEW.revision AND flux_artifact_xid_is_current(l.xmin)) INTO fresh;
  END IF;
  IF NOT fresh OR NOT EXISTS(SELECT 1 FROM agent_thread_artifact_mutations w
    WHERE w.kind=NEW.kind AND w.source_id=NEW.source_id AND w.revision=NEW.revision
      AND w.workspace_id=NEW.workspace_id AND w.project_id=NEW.project_id AND w.transaction_id=txid_current() AND w.progress) THEN
    RAISE EXCEPTION 'A fresh canonical artifact mutation with actual progress is required'
    USING ERRCODE='23514',CONSTRAINT='agent_thread_artifact_canonical'; END IF;
  NEW.transaction_id:=txid_current();RETURN NEW;
END $$;
