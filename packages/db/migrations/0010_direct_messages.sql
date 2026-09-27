-- Direct messages (issue #107): private conversations between people of one workspace,
-- independent of projects. The audience is exactly the rows in dm_participants. Removing a
-- workspace membership deletes that person's participant rows (composite foreign key with
-- ON DELETE CASCADE), so access ends with the membership. Authorization lives in
-- packages/core (docs/development/direct-messages.md). Numbered 0010: 0008 and 0009 are
-- reserved by open pull requests; the runner applies files in order and accepts gaps.

CREATE TABLE dms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pair', 'group')),
  -- 'pair': the two user ids in sorted order joined by ':'. One 1:1 DM per pair and workspace.
  pair_key text,
  title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 80),
  created_by text NOT NULL REFERENCES auth_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CHECK ((kind = 'pair') = (pair_key IS NOT NULL)),
  CHECK (kind = 'group' OR title IS NULL),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, pair_key)
);
CREATE INDEX dms_workspace_activity_idx ON dms(workspace_id, (coalesce(last_message_at, created_at)) DESC, id);

CREATE TABLE dm_participants (
  workspace_id uuid NOT NULL,
  dm_id uuid NOT NULL,
  user_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dm_id, user_id),
  FOREIGN KEY (workspace_id, dm_id) REFERENCES dms(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX dm_participants_user_idx ON dm_participants(workspace_id, user_id, dm_id);

-- The #36 message shape: per-DM sequence, author, and a client UUID reused only for retries.
CREATE TABLE dm_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  dm_id uuid NOT NULL,
  author_id text NOT NULL REFERENCES auth_users(id),
  client_message_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dm_id, sequence),
  UNIQUE (dm_id, author_id, client_message_id),
  FOREIGN KEY (workspace_id, dm_id) REFERENCES dms(workspace_id, id) ON DELETE CASCADE
);
