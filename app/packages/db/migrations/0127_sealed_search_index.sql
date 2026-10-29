-- F-030 encrypted workspaces, S2b (#655): the in-memory search index of an encrypted workspace is built from the placeholder
-- rows of `search_documents` and kept current from `search_changes`.
-- 0124-0126 are left to the other open slices (S2a-2b-2 files, #469 links, #68); this file depends on none of them.
--
-- 1. A change is read by the transaction that wrote it, not by its sequence number: a `bigserial` is assigned when the row is
--    inserted, so a transaction with a lower number can commit after one with a higher number has been read, and a reader that
--    advanced past the higher number would never see it. Every process remembers the first transaction id it has not applied and
--    reads the changes of the transactions below the snapshot's `xmin` (all of them finished) from there.
-- 2. The first build of an index reads one workspace's placeholder rows in id order.
ALTER TABLE search_changes ADD COLUMN xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX search_changes_xid_idx ON search_changes (workspace_id, xid);
CREATE INDEX search_documents_sealed_idx ON search_documents (workspace_id, id) WHERE sealed;
