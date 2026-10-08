-- Pre-use and post-use reversal of 0057 (#347). It is not applied by the migrator and never edits the schema
-- ledger: a reversal runner owns that. The index holds no data of its own, so dropping it loses nothing.
DROP INDEX IF EXISTS agent_command_receipts_activity_idx;
