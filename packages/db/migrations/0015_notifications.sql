-- Notifications from domain events, per-person preferences, delivery addresses and an email
-- outbox (issue #116, foundation 8.9). See docs/development/notifications.md.

-- Direct messages become a notification source; `reason` says why the row exists and
-- `event_id` binds it to the committed event it came from, once per recipient.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
  CHECK (source_type IN ('workspace', 'project', 'draft', 'dm'));
ALTER TABLE notifications
  ADD COLUMN reason text CHECK (reason IN ('mention', 'question', 'reply', 'dm', 'assigned', 'review')),
  ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  -- False when the person turned the inbox off for this reason but kept push or email: the row
  -- still backs those channels and the tap-time recheck, but the inbox list leaves it out.
  ADD COLUMN in_inbox boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX notifications_recipient_event_idx ON notifications(user_id, event_id) WHERE event_id IS NOT NULL;

-- The generator's position in the event log. The worker locks this row, reads events after
-- `seq` (which commit in seq order, see 0004), writes their notifications and advances it in
-- one transaction. Events from before this migration are not turned into notifications.
CREATE TABLE notification_cursor (
  id text PRIMARY KEY,
  seq bigint NOT NULL CHECK (seq >= 0)
);
INSERT INTO notification_cursor(id, seq) VALUES ('generator', coalesce((SELECT max(seq) FROM events), 0));

-- One row per person once they change anything; missing rows mean the documented defaults.
-- `channels` holds only the choices the person changed: {"mention": {"email": false}, ...}.
CREATE TABLE notification_preferences (
  user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  channels jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_destination text NOT NULL DEFAULT 'account' CHECK (email_destination IN ('account', 'extra', 'both', 'none')),
  quiet_enabled boolean NOT NULL DEFAULT false,
  quiet_start smallint NOT NULL DEFAULT 1320 CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end smallint NOT NULL DEFAULT 420 CHECK (quiet_end BETWEEN 0 AND 1439),
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Muted places: nothing from them notifies the person, on any channel.
CREATE TABLE notification_mutes (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('project', 'dm')),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_type, source_id)
);

-- The one extra delivery address per person. It is not an auth table: Better Auth never reads
-- it, so it can never sign in, reset a password or change a grant.
CREATE TABLE notification_addresses (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  verified_at timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use, expiring verification links. Only the SHA-256 of the token is stored.
CREATE TABLE notification_address_tokens (
  token_hash text PRIMARY KEY,
  address_id uuid NOT NULL REFERENCES notification_addresses(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_address_tokens_address_idx ON notification_address_tokens(address_id);

-- Email outbox: at most one row per (notification, address kind), so a repeated generation or
-- job never queues a second email. The worker moves queued → sending in a committed step
-- before it talks to SMTP and never sends a row that is not queued, so a retry after an
-- uncertain send does not duplicate it.
CREATE TABLE notification_emails (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  address_kind text NOT NULL CHECK (address_kind IN ('account', 'extra')),
  -- The address the send used, recorded when it was claimed.
  address text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'skipped')),
  skip_reason text,
  attempts integer NOT NULL DEFAULT 0,
  -- SHA-256 of the one-click unsubscribe token placed in this email.
  unsubscribe_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- The latest SMTP failure, shown to the recipient as "email delivery failed" (never a silent drop).
  last_error text,
  last_error_at timestamptz,
  UNIQUE (notification_id, address_kind)
);
CREATE INDEX notification_emails_user_created_idx ON notification_emails(user_id, created_at DESC);
