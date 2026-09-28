-- An invitation names an existing live session and people, without copying its
-- anchor title, message text, room ID or media grant. The unique key makes
-- retries and concurrent invitations to one recipient converge on one record.
CREATE TABLE live_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  inviter_id text NOT NULL REFERENCES auth_users(id),
  recipient_id text NOT NULL REFERENCES auth_users(id),
  response text NOT NULL DEFAULT 'pending'
    CHECK (response IN ('pending', 'later', 'text')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (session_id, recipient_id),
  CHECK (inviter_id <> recipient_id),
  CHECK ((response = 'pending') = (responded_at IS NULL)),
  FOREIGN KEY (workspace_id, project_id, session_id)
    REFERENCES live_sessions(workspace_id, project_id, id) ON DELETE CASCADE
);

CREATE INDEX live_invitations_recipient_idx
  ON live_invitations(recipient_id, response, created_at DESC, id DESC);

INSERT INTO flux_schema_version(version) VALUES (20) ON CONFLICT DO NOTHING;
