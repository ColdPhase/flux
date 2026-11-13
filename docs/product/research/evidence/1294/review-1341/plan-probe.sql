SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS pg_search; CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE sd (id bigserial PRIMARY KEY, title text, body text, audience_key text, sealed boolean DEFAULT false, kind text);
INSERT INTO sd (title, body, audience_key, kind) SELECT 't' || i, 'body ' || i, 'project:' || (i % 200), 'message' FROM generate_series(1, 100000) i;
CREATE INDEX sd_bm25 ON sd USING bm25 (id, (title::pdb.simple('alias=title_pl')), (audience_key::pdb.literal), (kind::pdb.literal)) WITH (key_field = 'id') WHERE NOT sealed;
CREATE TABLE sv (document_id bigint PRIMARY KEY REFERENCES sd(id), embedding halfvec(4) STORAGE PLAIN NOT NULL);
INSERT INTO sv SELECT id, '[1,2,3,4]' FROM sd;
ANALYZE;
SET enable_seqscan = off; SET paradedb.enable_custom_scan = on;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) WITH d AS MATERIALIZED (SELECT s.id, v.embedding <=> '[1,1,1,1]'::halfvec AS distance FROM sd s JOIN sv v ON v.document_id = s.id
  WHERE NOT s.sealed AND s.audience_key = ANY(ARRAY['project:1','project:2']) AND s.kind IN ('message')) SELECT count(*) FROM d;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) WITH d AS MATERIALIZED (SELECT s.id, v.embedding <=> '[1,1,1,1]'::halfvec AS distance FROM sd s JOIN sv v ON v.document_id = s.id
  WHERE NOT s.sealed AND s.audience_key = ANY(ARRAY['project:1','project:2']) AND s.id @@@ pdb.all()) SELECT count(*) FROM d;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) WITH d AS MATERIALIZED (SELECT s.id, (SELECT v.embedding <=> '[1,1,1,1]'::halfvec FROM sv v WHERE v.document_id = s.id) AS distance FROM sd s
  WHERE NOT s.sealed AND s.audience_key = ANY(ARRAY['project:1','project:2']) AND s.kind IN ('message') AND s.id @@@ pdb.all()) SELECT count(*) FROM d WHERE distance IS NOT NULL;
