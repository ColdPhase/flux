-- Project docs and wiki (#112). A doc is a #36 project material of kind 'doc': it reuses the
-- material row and its immutable version snapshots, so a message that cites a doc version keeps
-- citing exactly that text. A doc version adds its state (draft or published) and the reason for
-- the change. Docs are written through the doc API with Idempotency-Key and If-Match, so they
-- carry no per-row client mutation id.
ALTER TABLE project_materials
  ADD COLUMN kind text NOT NULL DEFAULT 'material' CHECK (kind IN ('material', 'doc')),
  ALTER COLUMN client_mutation_id DROP NOT NULL,
  ALTER COLUMN request_fingerprint DROP NOT NULL,
  ADD CONSTRAINT project_materials_client_mutation_check
    CHECK (kind = 'doc' OR (client_mutation_id IS NOT NULL AND request_fingerprint IS NOT NULL));
CREATE INDEX project_materials_docs_idx ON project_materials(project_id, updated_at DESC, id DESC) WHERE kind = 'doc';

ALTER TABLE project_material_versions
  ADD COLUMN state text CHECK (state IS NULL OR state IN ('draft', 'published')),
  ADD COLUMN reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500);

-- A version is a historical statement: it is never rewritten. Only removing the whole material
-- (its project is deleted) removes its versions.
CREATE FUNCTION forbid_material_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'material versions are immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER material_version_immutable BEFORE UPDATE ON project_material_versions
FOR EACH ROW EXECUTE FUNCTION forbid_material_version_update();

-- Docs join the typed links of #101: a doc links to what its current text mentions
-- (`mentions`, rewritten with each version) and to the result or decision it was added from
-- (`source`, kept). Work objects and other docs can link to a doc; a project sketch is a target.
ALTER TABLE project_object_links
  DROP CONSTRAINT project_object_links_role_check,
  DROP CONSTRAINT project_object_links_from_type_check,
  DROP CONSTRAINT project_object_links_to_type_check,
  ADD CONSTRAINT project_object_links_role_check
    CHECK (role IN ('source', 'affects', 'still_applies', 'about', 'related', 'mentions')),
  ADD CONSTRAINT project_object_links_from_type_check
    CHECK (from_type IN ('work', 'decision', 'result', 'doc')),
  ADD CONSTRAINT project_object_links_to_type_check
    CHECK (to_type IN ('message', 'thought', 'material', 'work', 'decision', 'result', 'doc', 'sketch'));
CREATE INDEX project_object_links_from_idx ON project_object_links(from_id);

INSERT INTO flux_schema_version(version) VALUES (13) ON CONFLICT DO NOTHING;
