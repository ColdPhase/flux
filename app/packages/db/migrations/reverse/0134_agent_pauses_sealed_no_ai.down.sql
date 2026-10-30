-- Reversal of 0134 (#614). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
DROP TRIGGER IF EXISTS a_sealed_workspace_no_ai ON agent_pauses;
