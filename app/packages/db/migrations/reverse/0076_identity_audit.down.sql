-- Reversal of 0076 (#315). Not applied by the migrator; a reversal runner owns the schema ledger.
-- Dropping auth_identity_audit loses the record of re-keys and unlinks; export it first.
DROP TABLE auth_identity_audit;
