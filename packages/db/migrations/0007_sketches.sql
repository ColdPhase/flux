-- Persistent sketches: thoughts on a map, many-to-many links between them (issue #69).
-- A sketch belongs to one workspace and either to a project (scope 'project') or to the
-- people in a direct conversation (scope 'direct': its participants; a private sketch is a
-- direct sketch with one participant). Composite foreign keys keep every thought, link and
-- participant in the sketch's workspace even if application code is wrong. Authorization
-- lives in packages/core (docs/development/sketches.md). Number 0006 is reserved by the
-- open conversation branch (#36); migrate.ts applies every unapplied file in order.

CREATE TABLE sketches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('project', 'direct')),
  project_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  created_by_user_id text REFERENCES auth_users(id),
  created_by_agent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'project') = (project_id IS NOT NULL)),
  CHECK ((created_by_user_id IS NULL) <> (created_by_agent_id IS NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_agent_id) REFERENCES agents(workspace_id, id)
);
CREATE INDEX sketches_workspace_idx ON sketches(workspace_id, updated_at DESC, id);
CREATE INDEX sketches_project_idx ON sketches(project_id) WHERE project_id IS NOT NULL;

-- The people of a direct sketch. A participant must be a current member of the workspace;
-- leaving the workspace removes the participation in the same statement.
CREATE TABLE sketch_participants (
  workspace_id uuid NOT NULL,
  sketch_id uuid NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sketch_id, user_id),
  FOREIGN KEY (workspace_id, sketch_id) REFERENCES sketches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX sketch_participants_user_idx ON sketch_participants(user_id);

-- A thought: text with a position, size and shape on the sketch's plane. A placement names an
-- existing object shown on the map (placement_type/placement_id). Removing the thought removes
-- only the placement: there is deliberately no foreign key or cascade to the placed object.
CREATE TABLE sketch_thoughts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  sketch_id uuid NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1000),
  x integer NOT NULL CHECK (x BETWEEN -100000 AND 100000),
  y integer NOT NULL CHECK (y BETWEEN -100000 AND 100000),
  width integer NOT NULL DEFAULT 184 CHECK (width BETWEEN 80 AND 800),
  height integer NOT NULL DEFAULT 72 CHECK (height BETWEEN 40 AND 800),
  shape text NOT NULL DEFAULT 'card' CHECK (shape IN ('card', 'pill', 'circle')),
  placement_type text CHECK (placement_type IN ('draft')),
  placement_id uuid,
  created_by_user_id text REFERENCES auth_users(id),
  created_by_agent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((placement_type IS NULL) = (placement_id IS NULL)),
  CHECK ((created_by_user_id IS NULL) <> (created_by_agent_id IS NULL)),
  UNIQUE (sketch_id, id),
  FOREIGN KEY (workspace_id, sketch_id) REFERENCES sketches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_agent_id) REFERENCES agents(workspace_id, id)
);
CREATE INDEX sketch_thoughts_sketch_idx ON sketch_thoughts(sketch_id, created_at, id);
CREATE INDEX sketch_thoughts_placement_idx ON sketch_thoughts(placement_type, placement_id) WHERE placement_id IS NOT NULL;

-- An undirected link between two thoughts of the same sketch, with an optional label. A thought
-- links to any number of others (many-to-many); one link per pair.
CREATE TABLE sketch_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  sketch_id uuid NOT NULL,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 80),
  created_by_user_id text REFERENCES auth_users(id),
  created_by_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id),
  CHECK ((created_by_user_id IS NULL) <> (created_by_agent_id IS NULL)),
  FOREIGN KEY (workspace_id, sketch_id) REFERENCES sketches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (sketch_id, from_id) REFERENCES sketch_thoughts(sketch_id, id) ON DELETE CASCADE,
  FOREIGN KEY (sketch_id, to_id) REFERENCES sketch_thoughts(sketch_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX sketch_links_pair_idx ON sketch_links(sketch_id, LEAST(from_id, to_id), GREATEST(from_id, to_id));
CREATE INDEX sketch_links_to_idx ON sketch_links(sketch_id, to_id);
