-- Restorable search index (#123). pg_dump and pg_restore run with an empty search_path, and
-- COPY computes the stored `search_documents.keys` column through `search_keys`, which calls
-- `search_key` and pg_trgm's `show_trgm` unqualified (0014). A restore of any database with
-- search rows therefore failed. Pinning the function's search_path makes it resolve the same
-- objects in every session; the keys it computes are unchanged. Numbered by merge order: the
-- next free version after main's 0021; branches merged later take the numbers after it.
ALTER FUNCTION search_keys(text, text, text) SET search_path = public, pg_catalog;
