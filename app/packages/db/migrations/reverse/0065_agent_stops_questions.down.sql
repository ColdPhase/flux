-- Pre-use reversal of 0065 (#347). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. After use it would discard the record of who stopped which agent and every asked question's
-- options and answer (the messages themselves stay), so run it only before the tables hold data you need.
DROP TABLE IF EXISTS agent_questions;
DROP TABLE IF EXISTS agent_stops;
