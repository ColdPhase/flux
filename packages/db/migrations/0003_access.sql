-- Workspaces, memberships, projects, grants, agent identities and drafts (issue #29, AC-2).
-- Every collaborative row carries workspace_id. Composite foreign keys make the database
-- reject a link between rows of different workspaces even if application code is wrong.
-- Authorization itself lives in packages/core (see docs/development/access-policy.md).

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_by text NOT NULL REFERENCES auth_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'restricted')),
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

-- An agent identity is never a human login. It belongs to one workspace and is owned
-- either by a person (owner_user_id) or by the workspace itself (owner_user_id NULL).
-- Revocation sets revoked_at; its grants stop applying immediately.
CREATE TABLE agents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  owner_user_id text REFERENCES auth_users(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

-- One grant per (project, principal). 'denied' is an explicit deny and wins over every
-- role and visibility rule. A human grantee must be a current member of the project's
-- workspace; removing the membership deletes the member's grants in the same statement.
CREATE TABLE project_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id text,
  agent_id uuid,
  role text NOT NULL CHECK (role IN ('contributor', 'viewer', 'denied')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (agent_id IS NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_grants_user_idx ON project_grants(project_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX project_grants_agent_idx ON project_grants(project_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX project_grants_user_lookup_idx ON project_grants(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX project_grants_agent_lookup_idx ON project_grants(agent_id) WHERE agent_id IS NOT NULL;

-- A minimal collaborative item. New drafts are private to their author.
CREATE TABLE drafts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid,
  owner_user_id text REFERENCES auth_users(id),
  owner_agent_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project', 'workspace')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (owner_agent_id IS NULL)),
  CHECK (visibility <> 'project' OR project_id IS NOT NULL),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_agent_id) REFERENCES agents(workspace_id, id)
);
CREATE INDEX drafts_workspace_idx ON drafts(workspace_id, created_at, id);
CREATE INDEX drafts_project_idx ON drafts(project_id) WHERE project_id IS NOT NULL;

-- Access events carry their tenant so later stream/replay code can filter by workspace.
ALTER TABLE events ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX events_workspace_idx ON events(workspace_id, created_at) WHERE workspace_id IS NOT NULL;

INSERT INTO flux_schema_version(version) VALUES (3) ON CONFLICT DO NOTHING;
