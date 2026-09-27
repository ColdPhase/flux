-- Work items, decisions, results and their many-to-many links (#101).
-- Every row carries (workspace_id, project_id); composite keys keep references inside one
-- project. Access is the project's: rows are read only after the access policy allowed it.
CREATE TABLE project_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  rationale text NOT NULL DEFAULT '' CHECK (length(rationale) <= 20000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'superseded')),
  proposed_by_kind text NOT NULL CHECK (proposed_by_kind IN ('human', 'agent')),
  proposed_by_id text NOT NULL,
  -- Only a person accepts; agents propose.
  decided_by text REFERENCES auth_users(id),
  decided_at timestamptz,
  supersedes_id uuid,
  superseded_by_id uuid,
  superseded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  CHECK ((status = 'proposed') = (decided_by IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
  CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL)),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, supersedes_id) REFERENCES project_decisions(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, superseded_by_id) REFERENCES project_decisions(workspace_id, project_id, id)
);
CREATE INDEX project_decisions_project_idx ON project_decisions(project_id, created_at DESC, id DESC);

CREATE TABLE project_work_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  outcome text NOT NULL DEFAULT '' CHECK (length(outcome) <= 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'not_pursued')),
  blocker text CHECK (blocker IS NULL OR (status = 'blocked' AND length(blocker) <= 2000)),
  owner_user_id text REFERENCES auth_users(id),
  owner_agent_id uuid REFERENCES agents(id),
  -- A pivot parks work without changing its status.
  parked_by_decision_id uuid,
  parked_at timestamptz,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('human', 'agent')),
  created_by_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  CHECK (owner_user_id IS NULL OR owner_agent_id IS NULL),
  CHECK ((parked_by_decision_id IS NULL) = (parked_at IS NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, parked_by_decision_id) REFERENCES project_decisions(workspace_id, project_id, id)
);
CREATE INDEX project_work_items_project_idx ON project_work_items(project_id, created_at DESC, id DESC);
CREATE INDEX project_work_items_owner_idx ON project_work_items(workspace_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE project_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  finding text NOT NULL CHECK (finding IN ('positive', 'negative')),
  evidence text NOT NULL DEFAULT '' CHECK (length(evidence) <= 20000),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('human', 'agent')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX project_results_project_idx ON project_results(project_id, created_at DESC, id DESC);

-- Typed many-to-many links. Targets are checked to exist in the same project when a link is
-- written; project objects are never deleted on their own, so a link keeps its meaning.
CREATE TABLE project_object_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('source', 'affects', 'still_applies', 'about', 'related')),
  from_type text NOT NULL CHECK (from_type IN ('work', 'decision', 'result')),
  from_id uuid NOT NULL,
  to_type text NOT NULL CHECK (to_type IN ('message', 'thought', 'material', 'work', 'decision', 'result')),
  to_id uuid NOT NULL,
  to_version integer CHECK (to_version IS NULL OR to_version > 0),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('human', 'agent')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((to_type = 'material') = (to_version IS NOT NULL)),
  CHECK (NOT (from_type = to_type AND from_id = to_id)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_object_links_unique_idx
  ON project_object_links(from_id, role, to_type, to_id, coalesce(to_version, 0));
CREATE INDEX project_object_links_to_idx ON project_object_links(to_id);
CREATE INDEX project_object_links_project_idx ON project_object_links(project_id);

INSERT INTO flux_schema_version(version) VALUES (8) ON CONFLICT DO NOTHING;
