-- Reversal of 0136 (#763, F-034). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- Run `restoreDecisionCards` (apps/server/src/docs/decision-cards.ts) first: it brings back each converted doc's
-- `from_version` text as a new version while the doc is unchanged since; then drop the ledgers.
DROP TABLE IF EXISTS doc_decision_card_failures;
DROP TABLE IF EXISTS doc_decision_card_migrations;
