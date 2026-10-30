-- Reversal of 0131 (#160). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Pauses in force are lost; the agents' tasks, holds and units are unchanged.
DROP TRIGGER IF EXISTS agent_pause_follows_hold ON project_work_items;
DROP FUNCTION IF EXISTS flux_agent_pause_follows_hold();
DROP TABLE IF EXISTS agent_pauses;
