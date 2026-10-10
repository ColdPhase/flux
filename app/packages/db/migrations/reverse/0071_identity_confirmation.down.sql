-- Reversal of 0071 (#312). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. The column only records when the provider last confirmed a person, so dropping it loses no account data.
ALTER TABLE auth_accounts DROP COLUMN confirmed_at;
