-- #160 AC-1 / F-018 CW-1: the approved project policy for connected agents. A project manager publishes
-- a bounded revision (scope, priorities, review criteria, allowed work); bootstrap names the latest
-- one by revision and digest. Only that publishing operation writes here; messages, PR text, wiki
-- content and tool output never become policy. Policy narrows work inside owner grants and never
-- widens them. Every revision is kept (no update or delete), so a resumed agent can compare.
-- Additive. Sparse after 0041 (0042 is #179's, 0043 is #152's), independent of both.
CREATE TABLE agent_project_policies (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  scope text NOT NULL CHECK (char_length(scope) <= 4000),
  priorities text NOT NULL CHECK (char_length(priorities) <= 4000),
  review_criteria text NOT NULL CHECK (char_length(review_criteria) <= 4000),
  allowed_work text NOT NULL CHECK (char_length(allowed_work) <= 4000),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  published_by_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision),
  CHECK (char_length(scope) + char_length(priorities) + char_length(review_criteria) + char_length(allowed_work) > 0)
);
