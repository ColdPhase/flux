-- Reversal of 0103 (#503). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. It refuses while a DM reply exists, because dropping the column would turn
-- private replies into root messages of the main conversation. Observations are dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dm_messages WHERE thread_root_id IS NOT NULL) THEN
    RAISE EXCEPTION '0103 reversal refused: direct-message replies exist';
  END IF;
END $$;
DROP TABLE project_message_observations;
DROP TABLE dm_message_observations;
DROP TRIGGER dm_messages_flat_thread ON dm_messages;
DROP FUNCTION dm_messages_flat_thread();
DROP INDEX dm_messages_roots_idx;
DROP INDEX dm_messages_thread_idx;
ALTER TABLE dm_messages DROP CONSTRAINT dm_messages_thread_root_not_self;
ALTER TABLE dm_messages DROP CONSTRAINT dm_messages_thread_root_fk;
ALTER TABLE dm_messages DROP COLUMN thread_root_id;
