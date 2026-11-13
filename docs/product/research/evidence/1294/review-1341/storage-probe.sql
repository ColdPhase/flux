SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS vector;
SELECT setseed(0.42);
CREATE TABLE centers AS SELECT c, (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1024) WHERE c > 0)::vector(1024) AS v FROM generate_series(1, 64) c;
CREATE TABLE src AS SELECT i AS id, l2_normalize(c.v + (SELECT array_agg((random() - 0.5) * 0.9) FROM generate_series(1, 1024) WHERE i > 0)::vector(1024)) AS embedding
  FROM generate_series(1, 50000) i JOIN centers c ON c.c = 1 + i % 64;
CREATE TABLE docs (id bigint PRIMARY KEY, aud int NOT NULL); INSERT INTO docs SELECT id, 1 FROM src;
CREATE TABLE v_default (id bigint PRIMARY KEY, embedding vector(1024) NOT NULL); INSERT INTO v_default SELECT * FROM src;
CREATE TABLE v_plain (id bigint PRIMARY KEY, embedding vector(1024) NOT NULL); ALTER TABLE v_plain ALTER COLUMN embedding SET STORAGE PLAIN; INSERT INTO v_plain SELECT * FROM src;
CREATE TABLE v_half (id bigint PRIMARY KEY, embedding halfvec(1024) NOT NULL); ALTER TABLE v_half ALTER COLUMN embedding SET STORAGE PLAIN; INSERT INTO v_half SELECT id, embedding::halfvec(1024) FROM src;
VACUUM ANALYZE;
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relname IN ('v_default', 'v_plain', 'v_half');
SELECT attname, attstorage FROM pg_attribute WHERE attrelid = 'v_default'::regclass AND attname = 'embedding';
CREATE TABLE q AS SELECT embedding AS v FROM src WHERE id = 777;
\timing on
SELECT count(*) FROM (SELECT x.id FROM v_default x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v FROM q), x.id LIMIT 50) t;
SELECT count(*) FROM (SELECT x.id FROM v_default x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v FROM q), x.id LIMIT 50) t;
SELECT count(*) FROM (SELECT x.id FROM v_plain x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v FROM q), x.id LIMIT 50) t;
SELECT count(*) FROM (SELECT x.id FROM v_plain x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v FROM q), x.id LIMIT 50) t;
SELECT count(*) FROM (SELECT x.id FROM v_half x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v::halfvec(1024) FROM q), x.id LIMIT 50) t;
SELECT count(*) FROM (SELECT x.id FROM v_half x JOIN docs d ON d.id = x.id WHERE d.aud = 1 ORDER BY x.embedding <=> (SELECT v::halfvec(1024) FROM q), x.id LIMIT 50) t;
\timing off
-- halfvec top 50 vs vector top 50
SELECT (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM v_default ORDER BY embedding <=> (SELECT v FROM q), id LIMIT 50) a)
     = (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM v_half ORDER BY embedding <=> (SELECT v::halfvec(1024) FROM q), id LIMIT 50) b) AS same_top50;
