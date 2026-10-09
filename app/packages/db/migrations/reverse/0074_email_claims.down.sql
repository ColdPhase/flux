-- Reversal of 0074 (#313). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. Dropping auth_email_claims loses the audit record of released addresses; export it first.
DROP TABLE auth_email_claims;
ALTER TABLE auth_users DROP COLUMN verification_required;
