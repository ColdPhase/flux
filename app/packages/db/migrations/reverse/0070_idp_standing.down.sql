-- Reversal of 0070 (#311). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. The table holds only the provider's offline refresh token and the standing derived from
-- it; dropping it makes every managed person sign in through the provider again, and loses no account data.
DROP TABLE auth_idp_standing;
