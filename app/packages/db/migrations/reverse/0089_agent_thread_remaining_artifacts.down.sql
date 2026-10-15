-- Never erase the provenance of an enabled producer's actual reset.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id
    WHERE r.sequence IS NOT NULL AND b.kind IN('thought','file','github_pr')) THEN
    RAISE EXCEPTION 'Cannot reverse 0089 after a remaining artifact reset';
  END IF;
END $$;
-- Historical rows are compatible with88 and remain preserved; only admission is restored.
CREATE OR REPLACE FUNCTION flux_verify_artifact_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
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
