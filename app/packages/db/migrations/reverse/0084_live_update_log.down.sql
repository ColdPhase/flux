-- Reversal of 0084 (#228). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. Before 0084 every head held its complete codec state, so the reversal is
-- refused once any head's state depends on logged updates after its snapshot.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM doc_live_heads WHERE snapshot_sequence <> sequence) THEN
    RAISE EXCEPTION '0084 reversal refused: a live room''s state is in its update log after the snapshot';
  END IF;
END $$;
ALTER TABLE doc_live_updates DROP CONSTRAINT IF EXISTS doc_live_update_ledger;
ALTER TABLE doc_live_updates DROP COLUMN IF EXISTS ledger;
ALTER TABLE doc_live_archives DROP CONSTRAINT IF EXISTS doc_live_archive_snapshot;
ALTER TABLE doc_live_archives DROP COLUMN IF EXISTS snapshot_sequence;
ALTER TABLE doc_live_heads DROP CONSTRAINT IF EXISTS doc_live_head_snapshot;
ALTER TABLE doc_live_heads DROP COLUMN IF EXISTS revision;
ALTER TABLE doc_live_heads DROP COLUMN IF EXISTS snapshot_sequence;
