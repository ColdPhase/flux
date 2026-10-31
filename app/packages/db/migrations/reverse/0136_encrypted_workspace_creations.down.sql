-- Reversal of 0136 (#670). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Only the creation counts of the last 15 minutes are lost.
DROP TABLE encrypted_workspace_creations;
