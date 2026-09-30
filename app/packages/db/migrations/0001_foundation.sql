CREATE TABLE IF NOT EXISTS flux_schema_version (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS samples (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  object_id uuid NOT NULL,
  actor_id text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sample_results (
  sample_id uuid PRIMARY KEY REFERENCES samples(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  worker_id text NOT NULL
);

INSERT INTO flux_schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
