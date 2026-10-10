-- A rollback never re-labels assistant-origin actions as human/external-agent actions.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_proposals WHERE compute_source = 'owner_assistant') THEN
    RAISE EXCEPTION 'Cannot reverse assistant settings while assistant-origin proposals exist; restore the matching image or an reviewed backup';
  END IF;
END $$;
DROP TABLE assistant_join_requests;
DROP TABLE assistant_settings;
DELETE FROM agent_connections WHERE compute_source = 'owner_assistant';
DROP INDEX agent_connections_assistant_owner_idx;
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_compute_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_compute_source_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_compute_source_check
  CHECK (compute_source IN ('user_operated_claude_code', 'user_operated_external_client'));
