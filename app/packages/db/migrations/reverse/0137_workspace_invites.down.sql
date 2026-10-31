-- Reversal of 0137 (F-035). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
DELETE FROM event_data_keys WHERE key = 'inviteId';
DROP TABLE IF EXISTS workspace_invites;
