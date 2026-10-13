-- Reversal of 0073 (#314). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. The table only remembers seen logout-token ids; dropping it allows a replay until each
-- token's own expiry, and loses no account data.
DROP TABLE auth_logout_tokens;
