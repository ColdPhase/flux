-- #58: a committed human result creates a durable candidate, not permission to spend.
-- The worker must reserve and revalidate in one transaction before any provider call.
CREATE TABLE proactive_comparison_outbox (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES proactive_comparison_rules(id),
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  result_id uuid NOT NULL REFERENCES project_results(id),
  source_fingerprint text NOT NULL CHECK (length(source_fingerprint) = 64),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'reserved', 'cancelled', 'unknown', 'completed')),
  connection_id uuid REFERENCES background_compute_connections(id),
  reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents BETWEEN 0 AND 50),
  reserved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, result_id, source_fingerprint),
  CHECK ((status = 'queued' AND connection_id IS NULL AND reserved_cents = 0 AND reserved_at IS NULL)
    OR (status = 'cancelled' AND connection_id IS NULL AND reserved_cents = 0 AND reserved_at IS NULL)
    OR (status IN ('reserved', 'unknown', 'completed') AND connection_id IS NOT NULL AND reserved_cents >= 5 AND reserved_at IS NOT NULL))
);
CREATE INDEX proactive_comparison_outbox_owner_time_idx ON proactive_comparison_outbox(owner_user_id, reserved_at)
  WHERE reserved_at IS NOT NULL;
CREATE UNIQUE INDEX proactive_comparison_outbox_owner_inflight_idx ON proactive_comparison_outbox(owner_user_id)
  WHERE status = 'reserved';
CREATE INDEX proactive_comparison_outbox_queued_idx ON proactive_comparison_outbox(created_at, id)
  WHERE status = 'queued';
INSERT INTO flux_schema_version(version) VALUES (23) ON CONFLICT DO NOTHING;
