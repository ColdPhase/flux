-- The Review rule goes (#959, C-9): a project's choice between "another connection" and "another owner" for a reviewer. Its route
-- (`GET`/`PUT /api/v1/projects/:id/review-policy`) and screen are gone; the rule that remains is fixed (an author's own connection
-- is never the reviewer of its work in the same run). There is no existing data to keep.
DROP TABLE public.cowork_review_policies;
