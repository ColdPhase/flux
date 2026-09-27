-- Project conversation and immutable material revisions (#36).
-- Composite keys keep every source citation in the conversation's project.
ALTER TABLE drafts ADD CONSTRAINT drafts_workspace_id_id_unique UNIQUE (workspace_id, id);
CREATE TABLE draft_versions (
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body text NOT NULL,
  visibility text NOT NULL,
  project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, version)
);
INSERT INTO draft_versions(draft_id, version, title, body, visibility, project_id, created_at)
SELECT id, version, title, body, visibility, project_id, updated_at FROM drafts;
CREATE FUNCTION preserve_draft_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO draft_versions(draft_id, version, title, body, visibility, project_id)
  VALUES (NEW.id, NEW.version, NEW.title, NEW.body, NEW.visibility, NEW.project_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_version_snapshot AFTER INSERT OR UPDATE OF version ON drafts
FOR EACH ROW EXECUTE FUNCTION preserve_draft_version();

CREATE TABLE project_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by text NOT NULL REFERENCES auth_users(id),
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX project_conversations_project_idx ON project_conversations(project_id, created_at DESC, id DESC);

CREATE TABLE project_materials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by text NOT NULL REFERENCES auth_users(id),
  client_mutation_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, created_by, client_mutation_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX project_materials_project_idx ON project_materials(project_id, created_at DESC, id DESC);

CREATE TABLE project_material_versions (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  material_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  url text,
  author_id text NOT NULL REFERENCES auth_users(id),
  client_mutation_id uuid,
  request_fingerprint text,
  source_draft_id uuid,
  source_draft_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, version),
  UNIQUE (workspace_id, project_id, material_id, version),
  CHECK ((source_draft_id IS NULL) = (source_draft_version IS NULL)),
  CHECK ((client_mutation_id IS NULL) = (request_fingerprint IS NULL)),
  -- A source draft remains an internal provenance reference. API responses never expose
  -- its title/body or the source id to a recipient without draft.read permission.
  FOREIGN KEY (workspace_id, project_id, material_id) REFERENCES project_materials(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_draft_id) REFERENCES drafts(workspace_id, id)
);
CREATE UNIQUE INDEX project_material_edit_retry_idx
  ON project_material_versions(material_id, author_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;

CREATE TABLE project_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_id text NOT NULL REFERENCES auth_users(id),
  client_message_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 100000),
  source_material_id uuid,
  source_material_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence),
  UNIQUE (project_id, author_id, client_message_id),
  CHECK ((source_material_id IS NULL) = (source_material_version IS NULL)),
  FOREIGN KEY (workspace_id, project_id, conversation_id) REFERENCES project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, source_material_id, source_material_version)
    REFERENCES project_material_versions(workspace_id, project_id, material_id, version)
);
CREATE INDEX project_messages_conversation_idx ON project_messages(conversation_id, sequence);

INSERT INTO flux_schema_version(version) VALUES (6) ON CONFLICT DO NOTHING;
