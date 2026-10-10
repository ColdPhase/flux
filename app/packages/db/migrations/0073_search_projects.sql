-- Projects are found by name (#465, foundation 8.12). A project keeps one search row whose audience
-- is its own `project:<id>`, so the access policy's project condition (`visibleFilter`, the same one
-- that gates every project and its objects) decides who sees it: a restricted project is absent for
-- everyone outside it, as its messages are. The name is the title; a project has no description.
ALTER TABLE search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_kind_check CHECK (kind IN (
  'project', 'message', 'dm_message', 'material', 'doc', 'work', 'decision', 'result', 'sketch', 'thought', 'draft', 'person'));

CREATE FUNCTION search_index_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'project:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('project:' || NEW.id, 'project', NEW.workspace_id, 'project:' || NEW.id, NEW.id, NEW.id::text, NULL, NULL,
    NEW.visibility, NEW.name, '', NULL, NULL, NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OF name, visibility OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION search_index_project();

-- Index what already exists.
SELECT search_put('project:' || p.id, 'project', p.workspace_id, 'project:' || p.id, p.id, p.id::text, NULL, NULL,
  p.visibility, p.name, '', NULL, NULL, p.updated_at) FROM projects p;
