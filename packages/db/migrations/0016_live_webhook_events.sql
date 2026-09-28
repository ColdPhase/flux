-- Deduplicate signed LiveKit delivery retries without retaining webhook payloads.
-- Only events mapped to the current Flux room generation are stored.
CREATE TABLE live_webhook_events (
  event_id text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  room_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_webhook_events_received_idx ON live_webhook_events(received_at);

INSERT INTO flux_schema_version(version) VALUES (16) ON CONFLICT DO NOTHING;
