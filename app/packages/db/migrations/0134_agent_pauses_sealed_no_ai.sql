-- F-030 / F-029 (#614 acceptance, 2026-10-30): agent_pauses (0131, #160) is an AI table with a workspace path, so it gets the
-- encrypted-workspace backstop of 0119 like every other: a row for a sealed workspace is refused first. No row changes.
-- Sparse after 0132 (0133 belongs to other open work).
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON agent_pauses FOR EACH ROW EXECUTE FUNCTION sealed_workspace_no_ai();
