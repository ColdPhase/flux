-- Addressed requests between clients and the review verdict record go (#973, F-036, C-9): the tools that sent, claimed, deferred,
-- declined and resolved them and read the inbox, the request cards in a task's Details and their storage. A unit of work (create,
-- claim, transfer, complete) stays, and so does the rule that a run is not reviewed by its own author's connection.
-- There is no existing data to keep.
DROP TABLE public.cowork_review_verdicts, public.cowork_delivery_intents, public.cowork_requests, public.cowork_request_lineages;

-- A pull request event reaches the holder of the task only; Flux no longer coordinates a review of its own whose echo it would hold back.
ALTER TABLE public.github_bridge_outbox DROP CONSTRAINT github_bridge_outbox_state_check;
ALTER TABLE public.github_bridge_outbox ADD CONSTRAINT github_bridge_outbox_state_check
  CHECK (state IN ('pending_audience_adapter', 'delivered', 'no_recipient', 'no_access'));
