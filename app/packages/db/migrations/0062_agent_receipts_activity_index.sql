-- #347: the Agents view reads each connection's latest completed action in a project (project-agents.ts,
-- DISTINCT ON connection ordered by completed_at). agent_command_receipts (0034) had only its primary key, so
-- that read scanned a connection's whole ledger. Carried over from the #183 review.
CREATE INDEX agent_command_receipts_activity_idx ON agent_command_receipts (connection_id, project_id, completed_at DESC);
