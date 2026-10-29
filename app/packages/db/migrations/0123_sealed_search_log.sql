-- F-030 encrypted workspaces, S2a-2b (#655). 0122 is #704's (message references); this file does not depend on it.
-- `search_change_log` writes `search_changes` for a sealed workspace's placeholder rows, but its source names neither
-- predicate, so 0121's selection left it unpinned (S2a-2a review). It runs with the same explicit path as every other
-- sealing function; the registry test names it and `idempotency_scope_required` besides the source-text selection.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION search_change_log() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
