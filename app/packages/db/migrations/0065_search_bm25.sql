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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search')
     OR NOT ('pg_search' = ANY (string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ','))) THEN
    RAISE EXCEPTION 'FLUX_DATABASE_IMAGE Flux v0.2.1 needs its own database image (ghcr.io/coldphase/flux-database, PostgreSQL 18 with pg_search preloaded). Run the release''s compose.yaml or ./flux upgrade; see docs/operations/upgrade.md, "v0.2.1: the database image changes". Nothing was changed.';
  END IF;
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
