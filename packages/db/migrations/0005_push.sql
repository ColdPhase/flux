-- Web Push subscriptions and the in-app notification inbox (issue #41).
-- A subscription belongs to one signed-in session on one browser/device. The endpoint URL
-- and keys are sensitive: anyone holding them can send to that device. Deleting the session
-- (sign-out, session revoke, revoke-others, password reset, account deletion) deletes the
-- subscription through the foreign key, so no auth path can leave a device subscribed.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expiration_time timestamptz,
  device_label text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_status integer
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_session_id_idx ON push_subscriptions(session_id);

-- Every notification lands here first; push is only a delivery channel on top of it. Each
-- row names its source object, and the recipient sees it (inbox, push preview) only while
-- the access policy lets them read that source (`<source_type>.read`).
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('workspace', 'project', 'draft')),
  source_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  url text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_workspace_source_check CHECK (source_type <> 'workspace' OR source_id = workspace_id)
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_source_idx ON notifications(source_type, source_id);
