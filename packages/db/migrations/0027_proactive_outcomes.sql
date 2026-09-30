-- #58 accepted outcome/accounting amendment: actual inspected metadata, distinct quiet
-- insufficient evidence and terminal zero-cost refusals. New numbers follow merge order.
ALTER TABLE proactive_comparison_outbox
  DROP CONSTRAINT proactive_comparison_outbox_status_check,
  DROP CONSTRAINT proactive_comparison_outbox_check,
  ADD COLUMN inspected_sources jsonb CHECK (inspected_sources IS NULL OR jsonb_typeof(inspected_sources) = 'array'),
  ADD COLUMN dispatch_started_at timestamptz;

-- Earlier cancelled rows never entered the paid adapter: retain their provenance and
-- safe code, while making their zero-cost terminal state explicit. Do not relabel an old
-- proposal's cited subset as a complete inspected vector, or infer a dispatch timestamp.
UPDATE proactive_comparison_outbox
SET status = 'not_run', failure_code = coalesce(failure_code, 'LEGACY_NOT_RUN'),
    reserved_cents = 0, reserved_at = NULL, connection_id = NULL,
    usage_input_tokens = 0, usage_output_tokens = 0, usage_estimated_cents = 0,
    finished_at = coalesce(finished_at, updated_at)
WHERE status = 'cancelled';

ALTER TABLE proactive_comparison_outbox
  ADD CONSTRAINT proactive_comparison_outbox_status_check
    CHECK (status IN ('queued', 'reserved', 'not_run', 'unknown', 'completed')),
  ADD CONSTRAINT proactive_comparison_outbox_lifecycle_check CHECK (
    (status = 'queued' AND connection_id IS NULL AND reserved_cents = 0 AND reserved_at IS NULL AND dispatch_started_at IS NULL)
    OR (status = 'not_run' AND connection_id IS NULL AND reserved_cents = 0 AND reserved_at IS NULL AND dispatch_started_at IS NULL
      AND coalesce(usage_input_tokens, -1) = 0 AND coalesce(usage_output_tokens, -1) = 0 AND coalesce(usage_estimated_cents, -1) = 0
      AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status IN ('reserved', 'unknown', 'completed') AND connection_id IS NOT NULL AND reserved_cents >= 5 AND reserved_at IS NOT NULL)
  );

CREATE TABLE proactive_comparison_insufficient_outcomes (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL UNIQUE REFERENCES proactive_comparison_outbox(id),
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  result_id uuid NOT NULL REFERENCES project_results(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proactive_comparison_insufficient_project_idx
  ON proactive_comparison_insufficient_outcomes(project_id, created_at DESC, id DESC);
ALTER TABLE proactive_comparison_outbox ADD COLUMN insufficient_outcome_id uuid
  REFERENCES proactive_comparison_insufficient_outcomes(id);
ALTER TABLE proactive_comparison_outbox
  ADD CONSTRAINT proactive_comparison_outbox_one_outcome_check
    CHECK (proposal_id IS NULL OR insufficient_outcome_id IS NULL),
  ADD CONSTRAINT proactive_comparison_outbox_insufficient_sources_check
    CHECK (insufficient_outcome_id IS NULL OR inspected_sources IS NOT NULL);

INSERT INTO flux_schema_version(version) VALUES (27) ON CONFLICT DO NOTHING;
