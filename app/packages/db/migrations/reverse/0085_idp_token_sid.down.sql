-- Reversal of 0085 (#314). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. Without the column Flux no longer knows which provider session a stored token belongs to;
-- no account data is lost.
ALTER TABLE auth_idp_standing DROP COLUMN refresh_token_sid;
