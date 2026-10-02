-- #152: project docs can be written by a genuine agent under an owner's standing grant, and the standing-grant
-- operation list gains the doc and project-conversation commands. Every existing row keeps its human author and
-- time: nothing is inferred or backfilled. Like #154's message actors (0037), an agent never occupies the human
-- author column; it has its own column bound to an agent of the same workspace, and exactly one of them is set.
-- Only docs (materials of kind 'doc', whose versions carry a state) can be agent-written; a plain #36 material
-- stays person-written. Idempotent. Sparse after 0041: 0042 is left to an open branch.
ALTER TABLE project_materials ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS created_by_agent_id uuid;
ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_material_exact_actor;
ALTER TABLE project_materials ADD CONSTRAINT project_material_exact_actor
  CHECK (num_nonnulls(created_by, created_by_agent_id) = 1);
ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_material_agent_doc;
ALTER TABLE project_materials ADD CONSTRAINT project_material_agent_doc
  CHECK (created_by_agent_id IS NULL OR kind = 'doc');
ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_material_agent_workspace;
ALTER TABLE project_materials ADD CONSTRAINT project_material_agent_workspace
  FOREIGN KEY (workspace_id, created_by_agent_id) REFERENCES agents(workspace_id, id);

-- Versions stay immutable: adding a nullable column and constraints rewrites no row and fires no UPDATE trigger.
ALTER TABLE project_material_versions ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE project_material_versions ADD COLUMN IF NOT EXISTS author_agent_id uuid;
ALTER TABLE project_material_versions DROP CONSTRAINT IF EXISTS project_material_version_exact_actor;
ALTER TABLE project_material_versions ADD CONSTRAINT project_material_version_exact_actor
  CHECK (num_nonnulls(author_id, author_agent_id) = 1);
ALTER TABLE project_material_versions DROP CONSTRAINT IF EXISTS project_material_version_agent_doc;
ALTER TABLE project_material_versions ADD CONSTRAINT project_material_version_agent_doc
  CHECK (author_agent_id IS NULL OR state IS NOT NULL);
ALTER TABLE project_material_versions DROP CONSTRAINT IF EXISTS project_material_version_agent_workspace;
ALTER TABLE project_material_versions ADD CONSTRAINT project_material_version_agent_workspace
  FOREIGN KEY (workspace_id, author_agent_id) REFERENCES agents(workspace_id, id);

-- Existing human search rows stay exact; a future agent-written version is indexed with its real actor.
CREATE OR REPLACE FUNCTION search_index_material_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  material_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'material:' || OLD.material_id || ':' || OLD.version; RETURN OLD; END IF;
  SELECT pm.kind INTO material_kind FROM project_materials pm WHERE pm.id = NEW.material_id;
  PERFORM search_put('material:' || NEW.material_id || ':' || NEW.version, coalesce(material_kind, 'material'), NEW.workspace_id, 'project:' || NEW.project_id,
    NEW.project_id, NEW.material_id::text, NULL, NEW.version, NEW.state, NEW.title, concat_ws(E'\n', NEW.body, NEW.url),
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;

-- The closed standing-grant operation list (0034, widened by 0038) gains exactly the four new commands.
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request'));
