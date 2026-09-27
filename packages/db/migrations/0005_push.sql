-- Web Push subscriptions and the in-app notification inbox (issue #41).
-- A subscription belongs to one signed-in user on one browser/device. The endpoint URL
-- and keys are sensitive: anyone holding them can send to that device.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
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

-- Every notification lands here first; push is only a delivery channel on top of it.
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  url text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);

INSERT INTO flux_schema_version(version) VALUES (3) ON CONFLICT DO NOTHING;
