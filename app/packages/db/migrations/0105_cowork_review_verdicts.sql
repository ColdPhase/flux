-- 0105 (#153 AC-4): a review verdict is the resolution of one review request. Numbered 0105 to stay clear of
-- pending 0104 (#580); the coordinator renumbers at merge.
--
-- The verdict is pinned to the exact target the request named (a task/material/doc/thought version, a result
-- or message ID, or a verified GitHub PR head). It is never rewritten: a newer version of the target makes it
-- stale when it is read, and a new review needs a new request. Findings and evidence live in the native record
-- the reviewer published first (evidence_ref); this table copies no content. Rows go with their request, task
-- or project in the same statement (project erasure, CW-2 retention).
CREATE TABLE cowork_review_verdicts (
  request_id uuid PRIMARY KEY REFERENCES cowork_requests(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  work_id uuid NOT NULL,
  reviewer_connection_id uuid NOT NULL,
  reviewer_owner_id text NOT NULL,
  author_connection_id uuid NOT NULL,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 1024),
  criteria_refs jsonb NOT NULL CHECK (jsonb_typeof(criteria_refs) = 'array' AND octet_length(criteria_refs::text) <= 8192),
  verdict text NOT NULL CHECK (verdict IN ('passed', 'changes_requested')),
  evidence_ref jsonb NOT NULL CHECK (jsonb_typeof(evidence_ref) = 'object' AND octet_length(evidence_ref::text) <= 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (reviewer_connection_id <> author_connection_id),
  FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX cowork_review_verdicts_work_idx ON cowork_review_verdicts(workspace_id, project_id, work_id, created_at);
