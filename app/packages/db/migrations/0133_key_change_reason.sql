-- F-030 encrypted workspaces, S3 (#655): why the key last changed. A rotation's `rotation_reason` (removed, demoted or
-- holder_deleted, with the person's id) is cleared at the finish; the finish now keeps it here, so People can say
-- "New key since 23 Oct, after Ben left." after the rotation. Ids and a kind only, like `rotation_reason`.
-- Numbered 0133, after #751's 0131 and 0132.
ALTER TABLE workspace_keys ADD COLUMN key_change_reason jsonb
  CHECK (key_change_reason IS NULL OR jsonb_typeof(key_change_reason) = 'object');

-- F-029/F-030 backstop: `agent_pauses` (0131, #751) is an AI table with a workspace path and came without the
-- `a_sealed_workspace_no_ai` trigger every such table gets (0119); an encrypted workspace never holds an AI row.
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON agent_pauses FOR EACH ROW EXECUTE FUNCTION sealed_workspace_no_ai();
