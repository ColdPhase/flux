-- Reversal of 0105 (#153). Not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. It forgets recorded review verdicts; the resolved requests keep their response refs.
DROP TABLE cowork_review_verdicts;
