-- #280 (F-022 T5): the owner's own Claude Code, run inside Flux, gets an agent connection of its own
-- with the compute source `owner_runtime`. Both CHECKs list it; nothing else changes.
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_compute_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client', 'owner_runtime'));
ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_compute_source_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client', 'owner_runtime'));
