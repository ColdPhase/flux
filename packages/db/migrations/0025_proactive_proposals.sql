-- #58: a quiet project proposal is a distinct, human-reviewable artifact.
-- The provider response is never an accepted work/decision/material edit.
CREATE TABLE proactive_comparison_proposals (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL UNIQUE REFERENCES proactive_comparison_outbox(id),
  owner_user_id text NOT NULL REFERENCES auth_users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  result_id uuid NOT NULL REFERENCES project_results(id),
  source_fingerprint text NOT NULL CHECK (length(source_fingerprint) = 64),
  sources jsonb NOT NULL,
  fact text NOT NULL CHECK (length(btrim(fact)) BETWEEN 1 AND 10000),
  interpretation text NOT NULL CHECK (length(btrim(interpretation)) BETWEEN 1 AND 10000),
  suggested_action text NOT NULL CHECK (length(btrim(suggested_action)) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'dismissed', 'used')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  edited_by_user_id text REFERENCES auth_users(id),
  used_work_id uuid UNIQUE REFERENCES project_work_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proactive_comparison_proposals_project_idx
  ON proactive_comparison_proposals(project_id, created_at DESC, id DESC);
ALTER TABLE proactive_comparison_outbox ADD COLUMN proposal_id uuid REFERENCES proactive_comparison_proposals(id);
ALTER TABLE proactive_comparison_outbox ADD COLUMN usage_input_tokens integer CHECK (usage_input_tokens >= 0);
ALTER TABLE proactive_comparison_outbox ADD COLUMN usage_output_tokens integer CHECK (usage_output_tokens >= 0);
ALTER TABLE proactive_comparison_outbox ADD COLUMN usage_estimated_cents integer CHECK (usage_estimated_cents >= 0);
ALTER TABLE proactive_comparison_outbox ADD COLUMN finished_at timestamptz;
ALTER TABLE proactive_comparison_outbox ADD COLUMN failure_code text;
INSERT INTO flux_schema_version(version) VALUES (25) ON CONFLICT DO NOTHING;
