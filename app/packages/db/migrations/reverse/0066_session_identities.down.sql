-- Reversal of 0066 (#310). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. The table only describes how a session signed in, so dropping it loses no account data.
DROP TABLE auth_session_identities;
