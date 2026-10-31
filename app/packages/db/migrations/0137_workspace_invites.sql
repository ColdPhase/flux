-- F-035 (#763 PE-2, founder decision 2026-10-31): one-time invite links that join a workspace with a role
-- (docs/development/access-policy.md#invite-links-f-035). Only the SHA-256 of the token is stored. Additive: no
-- existing row changes. Sparse after 0134 (0135 and 0136 belong to other open work).
CREATE TABLE workspace_invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  email text CHECK (email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 320)),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  accepted_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);
CREATE INDEX workspace_invites_pending_idx ON workspace_invites (workspace_id, created_at DESC)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;
-- F-030 event data: the invite's id is a key of `workspace.invite_*` and `workspace.member_added.v1` data.
INSERT INTO event_data_keys (key) VALUES ('inviteId') ON CONFLICT DO NOTHING;
