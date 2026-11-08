-- A Wiki page has no Draft / Published state (#942, F-038): nothing reads the column and nobody can set it. The two functions
-- that looked at it stop first (a change of state alone was a witnessed mutation of a page; a version's state was its search
-- status), then the column goes with the checks that named it. Every doc version is a published version, as it always read.
-- An agent-written version stays a doc version through the triggers that check the parent's kind
-- (project_material_version_agent_doc_parent); the check that used the state to say so goes with it.
CREATE OR REPLACE FUNCTION public.flux_capture_artifact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE artifact_kind text;source text;revision_key text;workspace uuid;project uuid;changed boolean;
  previous project_material_versions%ROWTYPE; map sketches%ROWTYPE; binding github_bindings%ROWTYPE;
BEGIN
  workspace:=NEW.workspace_id;
  IF TG_TABLE_NAME='project_material_versions' THEN
    project:=NEW.project_id;source:=NEW.material_id::text;revision_key:=NEW.version::text;
    SELECT kind INTO artifact_kind FROM project_materials WHERE id=NEW.material_id;
    SELECT * INTO previous FROM project_material_versions WHERE material_id=NEW.material_id AND version=NEW.version-1;
    changed:=NOT FOUND OR NEW.body IS DISTINCT FROM previous.body OR NEW.url IS DISTINCT FROM previous.url;
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
END $_$;

CREATE OR REPLACE FUNCTION public.search_index_material_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  material_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'material:' || OLD.material_id || ':' || OLD.version; RETURN OLD; END IF;
  SELECT pm.kind INTO material_kind FROM project_materials pm WHERE pm.id = NEW.material_id;
  PERFORM search_put('material:' || NEW.material_id || ':' || NEW.version, coalesce(material_kind, 'material'), NEW.workspace_id, 'project:' || NEW.project_id,
    NEW.project_id, NEW.material_id::text, NULL, NEW.version, NULL, NEW.title, concat_ws(E'\n', NEW.body, NEW.url),
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;

ALTER TABLE public.project_material_versions DROP COLUMN state;
