-- Search answers at once again with file text in the index (docs/development/search.md "The BM25 index writes whole segments").
--
-- pg_search 0.26 writes new rows to a mutable segment that holds only the rows' addresses: every reader of the index tokenizes those rows
-- again, for each field and each clause, at planning (its row estimates) and at execution. A search runs one clause per word and field
-- (21 for two words, 43 for six), so with the text of a few files in that segment (372 parts, about 1 MB) one search planned for 1 to
-- 4 s and the API's 2 s statement limit answered 500 ("Search is unavailable right now"); measured on Flux's image, 2026-11-16: 67 ms
-- to plan one clause with the rows mutable, 0.6 ms once they are a written segment. With `mutable_segment_rows = 0` every write is a
-- written segment, which pg_search merges in the background. The index is rebuilt so the rows already there are written too.
-- An index that replaces this one must keep the option (WITH (mutable_segment_rows = 0)).
ALTER INDEX public.search_documents_bm25_idx SET (mutable_segment_rows = 0);
REINDEX INDEX public.search_documents_bm25_idx;
