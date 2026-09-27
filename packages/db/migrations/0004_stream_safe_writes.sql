-- Event cursors, worker job results and idempotency keys (issue #29, AC-3/AC-4).
-- See docs/development/access-policy.md for the stream, worker and safe-write contracts.

-- Monotonic event sequence used as the stream cursor. A BEFORE INSERT trigger takes a
-- transaction-scoped advisory lock and then draws the next value, so transactions that
-- write events commit in seq order: once a reader sees seq N it has already seen every
-- committed event below N. Rolled back transactions leave harmless gaps. Domain methods
-- write their event last, so the lock is held only for the tail of a transaction.
ALTER TABLE events ADD COLUMN seq bigserial;
ALTER TABLE events ALTER COLUMN seq DROP DEFAULT;
CREATE UNIQUE INDEX events_seq_idx ON events(seq);

CREATE FUNCTION flux_events_assign_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('flux.events.seq'));
  NEW.seq := nextval(pg_get_serial_sequence('events', 'seq'));
  RETURN NEW;
END
$$;
CREATE TRIGGER events_assign_seq BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION flux_events_assign_seq();

-- Wake-up only: NOTIFY is delivered at commit and carries no content. The events table
-- stays the source of truth; stream connections also poll in case a notification is lost.
CREATE FUNCTION flux_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    PERFORM pg_notify('flux_events', NEW.seq::text);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER events_notify AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION flux_events_notify();

-- Per-recipient stream index. recordEvent decides each event's audience through the
-- access policy in the writing transaction and stores one row per recipient with the
-- event's seq, so rows commit together with (and in the order of) their event. Stream
-- connections read only their own rows, so the work to open a stream or replay after a
-- cursor never depends on events the recipient cannot see. Delivery still re-authorizes
-- every row. Events recorded before this migration have no rows and are not replayed.
CREATE TABLE event_audience (
  -- `<kind>:<id>` of the principal, as in events.actor_id.
  recipient text NOT NULL,
  seq bigint NOT NULL,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (recipient, seq)
);
CREATE INDEX event_audience_event_idx ON event_audience(event_id);

-- Results of draft.summarize.v1 jobs. The row is the durable job intent and outcome; the
-- pg-boss payload carries only its id. The requesting principal is rechecked by the worker
-- before it reads the draft and again inside the commit transaction.
CREATE TABLE draft_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  principal_kind text NOT NULL CHECK (principal_kind IN ('human', 'agent')),
  principal_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'denied')),
  -- 'before_read' or 'before_commit' when status = 'denied'.
  denied_at_stage text CHECK (denied_at_stage IN ('before_read', 'before_commit')),
  job_id text,
  draft_version integer,
  word_count integer CHECK (word_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'denied') = (denied_at_stage IS NOT NULL)),
  CHECK (status <> 'completed' OR word_count IS NOT NULL)
);
CREATE INDEX draft_results_draft_idx ON draft_results(draft_id, created_at);

-- Idempotency keys for POST/PATCH commands, scoped by principal, workspace (NULL for
-- commands outside a workspace) and operation. Only successful responses are stored, in
-- the same transaction as the change. Rows expire after 24 hours; an hourly worker job
-- deletes expired rows and lookups ignore them.
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  principal text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  operation text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb,
  response_etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX idempotency_keys_scope_idx ON idempotency_keys(principal, (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), operation, key);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

INSERT INTO flux_schema_version(version) VALUES (4) ON CONFLICT DO NOTHING;
