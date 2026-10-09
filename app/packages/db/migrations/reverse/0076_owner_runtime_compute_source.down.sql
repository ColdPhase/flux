-- A runtime connection and its proposals cannot survive the reversal of their check.
DELETE FROM agent_proposals WHERE compute_source = 'owner_runtime';
DELETE FROM agent_connections WHERE compute_source = 'owner_runtime';
ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_compute_source_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_compute_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
