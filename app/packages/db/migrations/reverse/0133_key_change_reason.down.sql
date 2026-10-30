-- Reversal of 0133 (#655). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Only why the key last changed is lost; the keys are untouched. The agent_pauses backstop goes with it.
DROP TRIGGER IF EXISTS a_sealed_workspace_no_ai ON agent_pauses;
ALTER TABLE workspace_keys DROP COLUMN key_change_reason;
