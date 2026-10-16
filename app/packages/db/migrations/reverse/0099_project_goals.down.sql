-- Reversal of 0099 (#520). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. It drops every project goal and its history.
DROP TABLE project_goals;
