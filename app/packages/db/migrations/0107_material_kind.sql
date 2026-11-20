-- A saved source (a "material") is a Wiki page, and the kind goes (#1508, C-71; founder decision on #1419 item 20, data half on #1424).
-- v0.2.2's migrations are 0100 to 0112; 0096–0099, 0102 and 0108 were never used, and the migrator applies the files there are, in order.
-- Every row stays: a material keeps its id, its versions (title, text, link, author, time), the messages and tasks that cite a version,
-- its search rows and its events; it is now read, edited and exported as a page of its space's Wiki. A version's link (`url`, sealed in an
-- encrypted space) stays on the version: the page shows it, and each later version keeps it (docs.ts `append`).

-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

-- The rules that told a doc from a material have nothing left to tell apart.
DROP TRIGGER material_agent_doc_stays_doc ON public.project_materials;
DROP FUNCTION public.material_agent_doc_stays_doc();
DROP TRIGGER material_version_agent_doc_parent ON public.project_material_versions;
DROP FUNCTION public.material_version_agent_doc_parent();

-- What happened to a material is what happened to a page: the Returns and the activity read it as a page's. The ids are kept, so an
-- encrypted space's events stay content-free (`docId` is a known key, the values are uuids and numbers).
UPDATE public.events SET kind = 'project.doc_created.v1', data = (data - 'materialId') || jsonb_build_object('docId', data -> 'materialId')
  WHERE kind = 'project.material_created.v1';
UPDATE public.events SET kind = 'project.doc_updated.v1', data = (data - 'materialId') || jsonb_build_object('docId', data -> 'materialId')
  WHERE kind = 'project.material_updated.v1';

-- Search finds a former material as a Wiki page; its key (`material:<id>:<version>`) and its text (with the link) are unchanged. The
-- kind is visible metadata in an encrypted space too, and the change log tells that space's devices to read the rows again.
UPDATE public.search_documents SET kind = 'doc' WHERE kind = 'material';
ALTER TABLE public.search_documents DROP CONSTRAINT search_documents_kind_check;
-- The kinds that stay are 0106's without `material` (0106 removed `result` and `draft`, which nothing writes).
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_kind_check CHECK (kind = ANY (ARRAY['project'::text, 'message'::text,
  'dm_message'::text, 'doc'::text, 'work'::text, 'decision'::text, 'sketch'::text, 'thought'::text, 'person'::text, 'file'::text]));

CREATE OR REPLACE FUNCTION public.search_index_material_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'material:' || OLD.material_id || ':' || OLD.version; RETURN OLD; END IF;
  PERFORM search_put('material:' || NEW.material_id || ':' || NEW.version, 'doc', NEW.workspace_id, 'project:' || NEW.project_id,
    NEW.project_id, NEW.material_id::text, NULL, NEW.version, NULL, NEW.title, concat_ws(E'\n', NEW.body, NEW.url),
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.live_session_doc_in_space() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.doc_id IS NULL OR TG_OP = 'UPDATE' AND NEW.doc_id IS NOT DISTINCT FROM OLD.doc_id
     AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
    RETURN NEW;
  END IF;
  PERFORM pm.id FROM project_materials pm
    WHERE pm.id = NEW.doc_id AND pm.workspace_id = NEW.workspace_id AND pm.project_id = NEW.project_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a live session''s page must be a page of its own space'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_sessions_doc_in_space';
  END IF;
  RETURN NEW;
END $$;

-- Every row is a page: the kind and the retry keys only a material's create and edit wrote go, with their checks and keys.
DROP INDEX public.project_materials_docs_idx;
ALTER TABLE public.project_materials
  DROP CONSTRAINT project_material_agent_doc,
  DROP CONSTRAINT project_materials_client_mutation_check,
  DROP CONSTRAINT project_materials_kind_check,
  DROP CONSTRAINT project_materials_project_id_created_by_client_mutation_id_key,
  DROP COLUMN kind,
  DROP COLUMN client_mutation_id,
  DROP COLUMN request_fingerprint;
CREATE INDEX project_materials_updated_idx ON public.project_materials USING btree (project_id, updated_at DESC, id DESC);
-- The table keeps no sealed column, so it needs no plaintext backstop.
DROP TRIGGER z_sealed_backstop ON public.project_materials;

DROP INDEX public.project_material_edit_retry_idx;
ALTER TABLE public.project_material_versions
  DROP CONSTRAINT project_material_versions_check1,
  DROP COLUMN client_mutation_id,
  DROP COLUMN request_fingerprint;
DROP TRIGGER z_sealed_backstop ON public.project_material_versions;
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON public.project_material_versions FOR EACH ROW
  WHEN (public.workspace_sealed(new.workspace_id)) EXECUTE FUNCTION public.flux_sealed_backstop('workspace_id', 'title', 'body', 'url', 'reason');
