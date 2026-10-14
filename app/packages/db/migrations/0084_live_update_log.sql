-- #228 Gate 4, founder direction 2026-10-09 (B1): an append-only update log with periodic
-- snapshot compaction. A text commit appends its update with the ledger entries it added and
-- advances the head's sequence, body, hash and revision; it no longer rewrites the whole codec
-- state. codec_state is the snapshot at snapshot_sequence, rewritten every bounded number of
-- updates and by enrollment. The state at the head is that snapshot plus the logged updates after
-- it. revision changes with every codec state change, so another API process can tell whether
-- its decoded room is current. Existing heads keep their full state as a snapshot at their sequence.
ALTER TABLE doc_live_heads ADD COLUMN IF NOT EXISTS snapshot_sequence bigint;
ALTER TABLE doc_live_heads ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
UPDATE doc_live_heads SET snapshot_sequence = sequence WHERE snapshot_sequence IS NULL;
ALTER TABLE doc_live_heads ALTER COLUMN snapshot_sequence SET DEFAULT 0, ALTER COLUMN snapshot_sequence SET NOT NULL;
ALTER TABLE doc_live_heads DROP CONSTRAINT IF EXISTS doc_live_head_snapshot;
ALTER TABLE doc_live_heads ADD CONSTRAINT doc_live_head_snapshot
  CHECK (snapshot_sequence BETWEEN 0 AND sequence AND revision BETWEEN 0 AND 9007199254740991);
-- Retired generations keep their snapshot position; NULL is an earlier archive whose state is complete.
ALTER TABLE doc_live_archives ADD COLUMN IF NOT EXISTS snapshot_sequence bigint;
ALTER TABLE doc_live_archives DROP CONSTRAINT IF EXISTS doc_live_archive_snapshot;
ALTER TABLE doc_live_archives ADD CONSTRAINT doc_live_archive_snapshot
  CHECK (snapshot_sequence IS NULL OR snapshot_sequence BETWEEN 0 AND sequence);
-- The ledger entries (nodes, deletions, splits) the update appended. NULL on updates logged
-- before this migration: their heads hold the complete state, so they are never replayed.
ALTER TABLE doc_live_updates ADD COLUMN IF NOT EXISTS ledger jsonb;
ALTER TABLE doc_live_updates DROP CONSTRAINT IF EXISTS doc_live_update_ledger;
ALTER TABLE doc_live_updates ADD CONSTRAINT doc_live_update_ledger
  CHECK (ledger IS NULL OR (jsonb_typeof(ledger) = 'object' AND octet_length(ledger::text) <= 8388608));
