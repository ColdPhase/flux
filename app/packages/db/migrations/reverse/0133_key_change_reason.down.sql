-- Reversal of 0133 (#655). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Only why the key last changed is lost; the keys are untouched.
ALTER TABLE workspace_keys DROP COLUMN key_change_reason;
