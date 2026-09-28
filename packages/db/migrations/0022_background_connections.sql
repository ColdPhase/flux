-- #58/O-007: owner-only background compute consent and encrypted key custody.
-- The active owner connection is separate from MCP OAuth, standing project rules,
-- triggering result events and eventual per-request reservations.
CREATE TABLE background_compute_connections (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'anthropic'),
  model text NOT NULL CHECK (model = 'claude-sonnet-5'),
  payer_organization text NOT NULL CHECK (length(btrim(payer_organization)) BETWEEN 2 AND 120),
  provider_workspace text NOT NULL CHECK (length(btrim(provider_workspace)) BETWEEN 2 AND 120),
  encrypted_key text,
  key_last_four text NOT NULL CHECK (length(key_last_four) = 4),
  key_fingerprint text NOT NULL CHECK (length(key_fingerprint) = 16),
  max_runs_per_day integer NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 3),
  period_days integer NOT NULL CHECK (period_days = 30),
  period_budget_cents integer NOT NULL CHECK (period_budget_cents BETWEEN 5 AND 1000),
  per_run_cents integer NOT NULL CHECK (per_run_cents BETWEEN 5 AND 50 AND per_run_cents <= period_budget_cents),
  consent_version text NOT NULL CHECK (consent_version = 'o-007-2026-09-28'),
  consented_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((encrypted_key IS NOT NULL) = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX background_compute_connections_active_owner_idx
  ON background_compute_connections(owner_user_id) WHERE revoked_at IS NULL;
CREATE INDEX background_compute_connections_owner_idx
  ON background_compute_connections(owner_user_id, created_at DESC, id);
INSERT INTO flux_schema_version(version) VALUES (22) ON CONFLICT DO NOTHING;
