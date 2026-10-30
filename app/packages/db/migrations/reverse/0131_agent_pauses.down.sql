-- Reversal of 0131 (#160). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Pauses in force are lost; the agents' tasks, holds and units are unchanged.
DROP TABLE IF EXISTS agent_pauses;
