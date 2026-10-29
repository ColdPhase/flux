-- Reversal of 0120 (F-030 S2a-1, #655). Not applied by the migrator. Refuses while an encrypted workspace exists: its
-- sealed rows would lose their backstops and its search rows their placeholder form.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE encrypted) THEN
    RAISE EXCEPTION 'An encrypted workspace exists; 0120 cannot be reversed' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTION_IMMUTABLE';
  END IF;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT DISTINCT event_object_table FROM information_schema.triggers WHERE trigger_schema = current_schema() AND trigger_name = 'a_sealed_workspace_refused'
  LOOP EXECUTE format('DROP TRIGGER a_sealed_workspace_refused ON %I', t); END LOOP;
  FOR t IN SELECT DISTINCT event_object_table FROM information_schema.triggers WHERE trigger_schema = current_schema() AND trigger_name = 'z_sealed_backstop'
  LOOP EXECUTE format('DROP TRIGGER z_sealed_backstop ON %I', t); END LOOP;
END $$;
DROP FUNCTION sealed_workspace_refused();
DROP FUNCTION flux_sealed_backstop();
DROP TRIGGER search_change_log ON search_documents;
DROP FUNCTION search_change_log();
DROP TABLE search_changes;
CREATE OR REPLACE FUNCTION search_put(p_key text, p_kind text, p_workspace uuid, p_audience text, p_project uuid, p_object text, p_parent uuid,
  p_version integer, p_status text, p_title text, p_body text, p_author_kind text, p_author text, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO search_documents(doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body, author_kind, author_id, at)
  VALUES (p_key, p_kind, p_workspace, p_audience, p_project, p_object, p_parent, p_version, p_status, coalesce(p_title, ''), coalesce(p_body, ''), p_author_kind, p_author, p_at)
  ON CONFLICT (doc_key) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id, audience_key = EXCLUDED.audience_key, project_id = EXCLUDED.project_id,
    parent_id = EXCLUDED.parent_id, version = EXCLUDED.version, status = EXCLUDED.status, title = EXCLUDED.title,
    body = EXCLUDED.body, author_kind = EXCLUDED.author_kind, author_id = EXCLUDED.author_id, at = EXCLUDED.at;
END $$;
ALTER TABLE search_documents DROP CONSTRAINT search_documents_sealed_placeholder;
ALTER TABLE search_documents DROP COLUMN sealed;
CREATE OR REPLACE FUNCTION preserve_draft_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO draft_versions(draft_id, version, title, body, visibility, project_id)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.body, NEW.visibility, NEW.project_id);
  RETURN NEW;
END;
$$;
-- Each relaxed check back to its own condition: the `flux_is_sealed(col) OR (` prefix and its closing parenthesis go.
DO $$
DECLARE c record; def text;
BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE contype = 'c' AND conname <> 'project_work_items_check' AND pg_get_constraintdef(oid) LIKE 'CHECK ((flux_is_sealed(%'
  LOOP
    def := regexp_replace(c.def, '^CHECK \(\(flux_is_sealed\([a-z0-9_]+\) OR (.*)\)\)$', '\1');
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (%s)', c.tbl, c.conname, c.conname, def);
  END LOOP;
END $$;
ALTER TABLE project_work_items DROP CONSTRAINT project_work_items_check, ADD CONSTRAINT project_work_items_check
  CHECK (blocker IS NULL OR (status = 'blocked' AND length(blocker) <= 2000));
DROP FUNCTION flux_is_sealed(jsonb);
DROP FUNCTION flux_is_sealed(text);
DROP TRIGGER artifact_material_delta ON project_material_versions;
DROP TRIGGER artifact_result_delta ON project_results;
DROP TRIGGER artifact_decision_delta ON project_decisions;
DROP TRIGGER artifact_thought_delta ON sketch_thoughts;
DROP TRIGGER artifact_file_delta ON project_files;
DROP TRIGGER artifact_pr_delta ON github_task_links;
CREATE TRIGGER artifact_material_delta AFTER INSERT ON project_material_versions FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_result_delta AFTER INSERT ON project_results FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_decision_delta AFTER INSERT OR UPDATE ON project_decisions FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_thought_delta AFTER INSERT OR UPDATE ON sketch_thoughts FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_file_delta AFTER UPDATE ON project_files FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_pr_delta AFTER INSERT OR UPDATE ON github_task_links FOR EACH ROW EXECUTE FUNCTION flux_capture_artifact_mutation();
