-- Agents and people's search rank by BM25 inside PostgreSQL (F-042, #1242, #1296).
--
-- One BM25 index (ParadeDB pg_search, in Flux's database image from v0.2.1) over search_documents, the table that triggers keep
-- current in the writer's own transaction for every searchable object (space and DM messages, the Wiki, tasks, decisions, maps,
-- people). Title and body are each indexed twice, with a Polish and an English stemmer, accents folded; the other fields filter.
-- The index stores no permission: every query passes the audiences the caller may read now (packages/db/src/repositories/search.ts).
-- Sealed rows (encrypted spaces) are placeholders without text and are left out. It follows every insert, edit and delete in the
-- same transaction, so it needs no job and adds no statement at idle.
--
-- Works on the data of any release from v0.2.0 on: the index is built from the rows already there. A database without pg_search
-- (not running Flux's database image) stops here, before anything changes.
--
-- It also finishes the move from v0.2.0's Alpine image (musl) to the Debian one (glibc). Both sort text byte by byte, so ordinary
-- B-tree indexes stay valid; but their case mapping and character classes differ for rare and recent Unicode characters (letters
-- added in Unicode 14 to 16, the circled letters, upper('ß'): about 100 code points for lower()/upper() and 9,900 for
-- to_tsvector, show_trgm and \w). So what was computed from those functions under musl is computed again here: the stored search
-- columns of search_documents whose values differ, and every index built from an expression, a text-dependent predicate or a
-- non-B-tree method. On a database that never ran on musl this changes nothing and costs one scan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search')
     OR NOT ('pg_search' = ANY (string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ','))) THEN
    RAISE EXCEPTION 'FLUX_DATABASE_IMAGE Flux v0.2.1 needs its own database image (ghcr.io/coldphase/flux-database, PostgreSQL 18 with pg_search preloaded). Run the release''s compose.yaml or ./flux upgrade; see docs/operations/upgrade.md, "v0.2.1: the database image changes". Nothing was changed.';
  END IF;
END
$$;

-- The stored search columns (tsv: to_tsvector; keys: search_keys, which uses to_tsvector and show_trgm): rows whose stored value is
-- not what this server computes. Writing title to itself makes PostgreSQL compute both again. Sealed rows carry no text and stay.
UPDATE public.search_documents SET title = title
WHERE tsv IS DISTINCT FROM (setweight(to_tsvector('simple'::regconfig, title), 'A'::"char")
                            || setweight(to_tsvector('simple'::regconfig, "left"(body, 100000)), 'B'::"char"))
   OR keys IS DISTINCT FROM public.search_keys(audience_key, title, body);

-- Indexes whose entries come from such functions: expression indexes (lower(email) among them), partial indexes whose predicate
-- uses them, and every index that is not a B-tree (the GIN of search_documents.keys). Plain B-trees keep byte order and stay.
-- Leaf indexes only: a partitioned index is rebuilt through its partitions' indexes, which this list holds.
DO $$
DECLARE target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i' AND c.relpersistence = 'p'
      AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      AND (i.indexprs IS NOT NULL OR am.amname <> 'btree'
        OR (i.indpred IS NOT NULL AND pg_get_expr(i.indpred, i.indrelid) ~* '(lower|upper|initcap|tsvector|tsquery|trgm|~|similar|like)'))
  LOOP
    EXECUTE format('REINDEX INDEX %s', target);
  END LOOP;
END
$$;

CREATE EXTENSION IF NOT EXISTS pg_search CASCADE;

CREATE INDEX search_documents_bm25_idx ON public.search_documents USING bm25 (
  id,
  (title::pdb.simple('ascii_folding=true', 'stemmer=polish', 'alias=title_pl')),
  (title::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=title_en')),
  (body::pdb.simple('ascii_folding=true', 'stemmer=polish', 'alias=body_pl')),
  (body::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=body_en')),
  (kind::pdb.literal),
  (audience_key::pdb.literal),
  (author_kind::pdb.literal),
  (author_id::pdb.literal),
  workspace_id,
  project_id,
  parent_id,
  at
) WHERE NOT sealed;
