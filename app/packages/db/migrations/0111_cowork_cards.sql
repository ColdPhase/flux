-- 0111 (#153 AC-2/AC-4, #400 AC-4): two additive changes; no existing row changes.
--  * cowork_requests.cancelled_by: the person who cancelled an open request from its card in the task's agents' thread.
--    NULL for every request that was not cancelled by a person (and after that person's account is deleted).
--  * cowork_review_policies: a project manager's explicit choice of how separate a reviewer must be from the author.
--    A project without a row keeps the contract default `distinct_connection` (another connection of any owner,
--    including the author's own owner); `distinct_owner` requires another owner. The agents never set it.
ALTER TABLE cowork_requests ADD COLUMN cancelled_by text REFERENCES auth_users(id) ON DELETE SET NULL;

CREATE TABLE cowork_review_policies (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  review_separation text NOT NULL CHECK (review_separation IN ('distinct_connection', 'distinct_owner')),
  updated_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
