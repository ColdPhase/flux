-- Reversal of 0135 (#763, F-034). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Converted docs keep their later version; restoring each `from_version` brings the copied sections back.
DROP TABLE IF EXISTS doc_decision_card_migrations;
