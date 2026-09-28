-- #58: standing authorization is distinct from a human result event. No job may
-- dispatch from this row alone; the worker must check current rights and budget.
CREATE TABLE proactive_comparison_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  trigger_kind text NOT NULL DEFAULT 'human_negative_result' CHECK (trigger_kind = 'human_negative_result'),
  purpose text NOT NULL DEFAULT 'camera_sensor_comparison' CHECK (purpose = 'camera_sensor_comparison'),
  data_scope text NOT NULL DEFAULT 'current_project_published' CHECK (data_scope = 'current_project_published'),
  permitted_effect text NOT NULL DEFAULT 'quiet_project_proposal' CHECK (permitted_effect = 'quiet_project_proposal'),
  max_runs_per_day integer NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 3),
  period_budget_cents integer NOT NULL CHECK (period_budget_cents BETWEEN 5 AND 500),
  per_run_cents integer NOT NULL CHECK (per_run_cents BETWEEN 5 AND 50 AND per_run_cents <= period_budget_cents),
  status text NOT NULL DEFAULT 'paused' CHECK (status IN ('enabled', 'paused', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (owner_user_id, project_id, purpose),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id)
);
CREATE INDEX proactive_comparison_rules_owner_idx ON proactive_comparison_rules(owner_user_id, project_id);
INSERT INTO flux_schema_version(version) VALUES (21) ON CONFLICT DO NOTHING;
