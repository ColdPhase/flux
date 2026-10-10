-- Reversal of 0075 (#315). Not applied by the migrator; a reversal runner owns the schema ledger.
-- Dropping auth_link_intents loses the record of pending and used links; export it first.
DROP TABLE auth_link_intents;
