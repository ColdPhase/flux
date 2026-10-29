-- F-030 encrypted workspaces, S2a-1 (#655; docs/product/encrypted-workspaces.md#enforcement):
--  1. Human writes in a sealed workspace no longer reach the agent-thread witness tables. Those AI-class tables have
--     `a_sealed_workspace_no_ai` (0119), so creating a decision, result, doc version, thought or published file in a
--     sealed workspace failed with 409 WORKSPACE_ENCRYPTED_AI_OFF. No agent thread can exist there, so nothing is
--     witnessed: the capture triggers skip a sealed workspace.
--  2. `flux_is_sealed`, and the plaintext backstop on every table of `SEALED_COLUMNS` (packages/db/src/sealed-columns.ts):
--     a row of a sealed workspace whose sealed column holds anything but an envelope is refused with
--     WORKSPACE_PLAINTEXT_REFUSED, naming the column, never the value. A table whose repository does not seal yet
--     therefore refuses a sealed workspace's writes instead of storing text (fail closed).
--  3. Checks over sealed columns become `flux_is_sealed(col) OR (<old check>)`; the application enforces the limits
--     before sealing.
--  4. `preserve_draft_version` writes nothing for a sealed workspace; the drafts repository inserts the sealed row.
--  5. Search placeholders: for a sealed workspace `search_put` stores no title or body (`sealed = true`), and every
--     change of such a row is appended to `search_changes` for S2b's in-memory index.
--  6. GitHub is not offered in a sealed workspace: `a_sealed_workspace_refused` on its tables with a workspace path.

-- 1. The agent-thread witnesses skip a sealed workspace.
DROP TRIGGER artifact_material_delta ON project_material_versions;
DROP TRIGGER artifact_result_delta ON project_results;
DROP TRIGGER artifact_decision_delta ON project_decisions;
DROP TRIGGER artifact_thought_delta ON sketch_thoughts;
DROP TRIGGER artifact_file_delta ON project_files;
DROP TRIGGER artifact_pr_delta ON github_task_links;
CREATE TRIGGER artifact_material_delta AFTER INSERT ON project_material_versions FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_result_delta AFTER INSERT ON project_results FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_decision_delta AFTER INSERT OR UPDATE ON project_decisions FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_thought_delta AFTER INSERT OR UPDATE ON sketch_thoughts FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_file_delta AFTER UPDATE ON project_files FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();
CREATE TRIGGER artifact_pr_delta AFTER INSERT OR UPDATE ON github_task_links FOR EACH ROW
  WHEN (NOT workspace_sealed(NEW.workspace_id)) EXECUTE FUNCTION flux_capture_artifact_mutation();

-- 2. Envelopes: `fx1.<version>.<base64url>` as text, `{"$sealed": envelope}` (or the bare envelope string) as jsonb.
CREATE FUNCTION flux_is_sealed(value text) RETURNS boolean IMMUTABLE STRICT LANGUAGE sql AS
  $$ SELECT value ~ '^fx1\.[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{38,}$' $$;
-- Never NULL for a value: an object without `$sealed` is false, not unknown.
CREATE FUNCTION flux_is_sealed(value jsonb) RETURNS boolean IMMUTABLE STRICT LANGUAGE sql AS $$
  SELECT coalesce(CASE jsonb_typeof(value)
    WHEN 'string' THEN flux_is_sealed(value #>> '{}')
    WHEN 'object' THEN (SELECT count(*) FROM jsonb_object_keys(value)) = 1 AND jsonb_typeof(value -> '$sealed') = 'string'
      AND flux_is_sealed(value ->> '$sealed')
    ELSE false END, false) $$;

-- TG_ARGV[0] is the workspace path ('workspace_id', or 'via:<column>:<parent table>:<parent key>'), the rest the sealed
-- columns. NULL and '' carry no content and pass.
CREATE FUNCTION flux_sealed_backstop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  path text[] := string_to_array(TG_ARGV[0], ':');
  ws uuid;
  v jsonb;
BEGIN
  IF path[1] = 'workspace_id' THEN
    ws := (r ->> 'workspace_id')::uuid;
  ELSIF r ->> path[2] IS NOT NULL THEN
    EXECUTE format('SELECT workspace_id FROM %I WHERE %I = $1', path[3], path[4]) INTO ws USING (r ->> path[2])::uuid;
  END IF;
  IF ws IS NULL OR NOT workspace_sealed(ws) THEN RETURN NEW; END IF;
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    v := r -> TG_ARGV[i];
    CONTINUE WHEN v IS NULL OR v = 'null'::jsonb OR v = '""'::jsonb;
    IF flux_is_sealed(v) IS NOT TRUE THEN
      RAISE EXCEPTION 'An encrypted workspace refuses plaintext in %.%', TG_TABLE_NAME, TG_ARGV[i]
        USING ERRCODE = 'FX409', HINT = 'WORKSPACE_PLAINTEXT_REFUSED';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- The same lists as SEALED_COLUMNS; the registry test compares them with pg_trigger.
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'name');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_goals FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_messages FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'body', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON dms FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON dm_messages FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'body', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_decisions FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title', 'rationale');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_results FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title', 'evidence');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title', 'body');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON draft_versions FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('via:draft_id:drafts:id', 'title', 'body');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'response_body', 'request_hash');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_work_items FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title', 'outcome', 'blocker', 'criteria', 'creation_baseline', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_task_activity FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'detail');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_task_updates FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'reason');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_task_plan_intents FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'creation_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON task_creation_undo_receipts FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON native_command_receipts FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_materials FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_material_versions FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title', 'body', 'url', 'reason', 'request_fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON sketches FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'title');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON sketch_thoughts FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'text');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON sketch_links FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'label');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON project_files FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'name', 'sha256');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON doc_live_heads FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'body', 'codec_state', 'hash');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON doc_live_archives FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('via:doc_id:project_materials:id', 'body', 'codec_state', 'hash');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON doc_live_updates FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('via:doc_id:project_materials:id', 'bytes', 'ledger', 'fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON doc_live_snapshots FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'hash');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON live_editing_intents FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('workspace_id', 'receipt', 'fingerprint');
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON map_live_journal FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop('via:sketch_id:sketches:id', 'change', 'fingerprint');

-- 3. Checks over sealed columns accept an envelope; the old check still holds for every plain value.
CREATE FUNCTION pg_temp.relax(tbl regclass, con text, col text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT def FROM pg_constraint WHERE conrelid = tbl AND conname = con AND contype = 'c';
  def := regexp_replace(def, '^CHECK \((.*)\)$', '\1');
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (flux_is_sealed(%I) OR (%s))', tbl, con, con, col, def);
END $$;
SELECT pg_temp.relax(t::regclass, c, col) FROM (VALUES
  ('projects', 'projects_name_check', 'name'),
  ('project_goals', 'project_goals_title_check', 'title'),
  ('project_messages', 'project_message_body_or_attachments', 'body'),
  ('dms', 'dms_title_check', 'title'),
  ('dm_messages', 'dm_messages_body_check', 'body'),
  ('project_decisions', 'project_decisions_title_check', 'title'),
  ('project_decisions', 'project_decisions_rationale_check', 'rationale'),
  ('project_results', 'project_results_title_check', 'title'),
  ('project_results', 'project_results_evidence_check', 'evidence'),
  ('drafts', 'drafts_title_check', 'title'),
  ('drafts', 'drafts_body_check', 'body'),
  ('project_work_items', 'project_work_items_title_check', 'title'),
  ('project_work_items', 'project_work_items_outcome_check', 'outcome'),
  ('project_work_items', 'project_work_criteria_bounded', 'criteria'),
  ('project_task_plan_intents', 'project_task_plan_intents_creation_fingerprint_check', 'creation_fingerprint'),
  ('project_material_versions', 'project_material_versions_title_check', 'title'),
  ('project_material_versions', 'project_material_versions_body_check', 'body'),
  ('project_material_versions', 'project_material_versions_reason_check', 'reason'),
  ('sketches', 'sketches_title_check', 'title'),
  ('sketch_thoughts', 'sketch_thoughts_text_check', 'text'),
  ('sketch_links', 'sketch_links_label_check', 'label'),
  ('project_files', 'project_files_name_check', 'name'),
  ('project_files', 'project_files_sha256_check', 'sha256'),
  ('doc_live_heads', 'doc_live_head_body', 'body'),
  ('doc_live_heads', 'doc_live_head_hash', 'hash'),
  ('doc_live_archives', 'doc_live_archive_body', 'body'),
  ('doc_live_archives', 'doc_live_archive_hash', 'hash'),
  ('doc_live_updates', 'doc_live_update_bytes', 'bytes'),
  ('doc_live_updates', 'doc_live_update_fingerprint', 'fingerprint'),
  ('doc_live_snapshots', 'doc_live_snapshot_hash', 'hash'),
  ('live_editing_intents', 'live_editing_intent_fingerprint', 'fingerprint'),
  ('map_live_journal', 'map_live_journal_fingerprint_check', 'fingerprint')
) AS checks(t, c, col);
-- The blocker check also ties a blocker to the blocked status; only its length part is relaxed.
ALTER TABLE project_work_items DROP CONSTRAINT project_work_items_check, ADD CONSTRAINT project_work_items_check
  CHECK (blocker IS NULL OR (status = 'blocked' AND (flux_is_sealed(blocker) OR length(blocker) <= 2000)));

-- 4. A sealed workspace's draft versions are written by the application, sealed with the version's own identity.
CREATE OR REPLACE FUNCTION preserve_draft_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  INSERT INTO draft_versions(draft_id, version, title, body, visibility, project_id)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.body, NEW.visibility, NEW.project_id);
  RETURN NEW;
END;
$$;

-- 5. Search placeholders. Person rows (account names) keep the SQL path.
ALTER TABLE search_documents ADD COLUMN sealed boolean NOT NULL DEFAULT false;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_sealed_placeholder CHECK (NOT sealed OR (title = '' AND body = ''));
CREATE TABLE search_changes (
  seq bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_changes_workspace_idx ON search_changes (workspace_id, seq);
CREATE INDEX search_changes_at_idx ON search_changes (at);

CREATE OR REPLACE FUNCTION search_put(p_key text, p_kind text, p_workspace uuid, p_audience text, p_project uuid, p_object text, p_parent uuid,
  p_version integer, p_status text, p_title text, p_body text, p_author_kind text, p_author text, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE placeholder boolean := p_kind <> 'person' AND workspace_sealed(p_workspace);
BEGIN
  INSERT INTO search_documents(doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body, author_kind, author_id, at, sealed)
  VALUES (p_key, p_kind, p_workspace, p_audience, p_project, p_object, p_parent, p_version, p_status,
    CASE WHEN placeholder THEN '' ELSE coalesce(p_title, '') END, CASE WHEN placeholder THEN '' ELSE coalesce(p_body, '') END,
    p_author_kind, p_author, p_at, placeholder)
  ON CONFLICT (doc_key) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id, audience_key = EXCLUDED.audience_key, project_id = EXCLUDED.project_id,
    parent_id = EXCLUDED.parent_id, version = EXCLUDED.version, status = EXCLUDED.status, title = EXCLUDED.title,
    body = EXCLUDED.body, author_kind = EXCLUDED.author_kind, author_id = EXCLUDED.author_id, at = EXCLUDED.at, sealed = EXCLUDED.sealed;
END $$;

CREATE FUNCTION search_change_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.sealed THEN INSERT INTO search_changes (workspace_id, doc_key) VALUES (OLD.workspace_id, OLD.doc_key); END IF;
    RETURN OLD;
  END IF;
  IF NEW.sealed THEN INSERT INTO search_changes (workspace_id, doc_key) VALUES (NEW.workspace_id, NEW.doc_key); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_change_log AFTER INSERT OR UPDATE OR DELETE ON search_documents FOR EACH ROW EXECUTE FUNCTION search_change_log();

-- 6. GitHub is refused in a sealed workspace.
CREATE FUNCTION sealed_workspace_refused() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  uuid_text text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ws uuid;
BEGIN
  IF coalesce(r ->> 'workspace_id', '') ~* uuid_text THEN
    ws := (r ->> 'workspace_id')::uuid;
  ELSIF coalesce(r ->> 'project_id', '') ~* uuid_text THEN
    SELECT workspace_id INTO ws FROM projects WHERE id = (r ->> 'project_id')::uuid;
  END IF;
  IF ws IS NOT NULL AND workspace_sealed(ws) THEN
    RAISE EXCEPTION 'GitHub is not available in an encrypted workspace' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTED_UNSUPPORTED';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.tables c
    WHERE c.table_schema = current_schema() AND c.table_type = 'BASE TABLE' AND c.table_name LIKE 'github%'
      AND c.table_name NOT IN ('github_credentials', 'github_oauth_flows')
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
        AND k.column_name IN ('workspace_id', 'project_id'))
    ORDER BY c.table_name
  LOOP
    EXECUTE format('CREATE TRIGGER a_sealed_workspace_refused BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION sealed_workspace_refused()', t);
  END LOOP;
END $$;
