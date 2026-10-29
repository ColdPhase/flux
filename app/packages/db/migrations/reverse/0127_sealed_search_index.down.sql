-- Reversal of 0127 (F-030 S2b, #655). Not applied by the migrator.
DROP INDEX IF EXISTS search_documents_sealed_idx;
DROP INDEX IF EXISTS search_changes_xid_idx;
ALTER TABLE search_changes DROP COLUMN IF EXISTS xid;
