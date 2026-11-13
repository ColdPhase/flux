-- Does the HNSW list of visible rows depend on hidden rows? And what does the exact list over visible rows cost?
\timing off
SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS vector;
SELECT setseed(0.42);
CREATE TABLE centers AS SELECT c, (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1024) WHERE c > 0)::vector(1024) AS v FROM generate_series(1, 64) c;
-- 10,000 visible rows (aud 1) in 64 topics.
CREATE TABLE docs (id bigint PRIMARY KEY, aud int NOT NULL);
CREATE TABLE vecs (id bigint PRIMARY KEY REFERENCES docs(id), embedding vector(1024) NOT NULL);
INSERT INTO docs SELECT i, 1 FROM generate_series(1, 10000) i;
INSERT INTO vecs SELECT i, l2_normalize(c.v + (SELECT array_agg((random() - 0.5) * 0.9) FROM generate_series(1, 1024) WHERE i > 0)::vector(1024))
  FROM generate_series(1, 10000) i JOIN centers c ON c.c = 1 + i % 64;
-- 20 queries, near topic centres.
CREATE TABLE queries AS SELECT q, l2_normalize(c.v + (SELECT array_agg((random() - 0.5) * 0.9) FROM generate_series(1, 1024) WHERE q > 0)::vector(1024)) AS v
  FROM generate_series(1, 20) q JOIN centers c ON c.c = 1 + (q * 7) % 64;
CREATE INDEX vecs_hnsw ON vecs USING hnsw (embedding vector_cosine_ops);
ANALYZE;
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.ef_search = 1000;
CREATE FUNCTION hnsw_top(qv vector, n int) RETURNS bigint[] LANGUAGE sql AS $$
  SELECT array_agg(id ORDER BY d, id) FROM (SELECT v.id, v.embedding <=> qv AS d FROM vecs v JOIN docs d ON d.id = v.id WHERE d.aud = 1
    ORDER BY v.embedding <=> qv LIMIT n) t $$;
CREATE FUNCTION exact_top(qv vector, n int) RETURNS bigint[] LANGUAGE sql AS $$
  SELECT array_agg(id ORDER BY d, id) FROM (SELECT id, d FROM (SELECT v.id, (v.embedding <=> qv) + 0 AS d FROM vecs v JOIN docs d ON d.id = v.id WHERE d.aud = 1) x
    ORDER BY d, id LIMIT n) t $$;
CREATE TABLE before AS SELECT q.q, hnsw_top(q.v, 50) AS h, exact_top(q.v, 50) AS e FROM queries q;
-- Hidden rows (aud 2): 2,000 near the queries' own topics, as a writer in a restricted space could add.
INSERT INTO docs SELECT 100000 + i, 2 FROM generate_series(1, 2000) i;
INSERT INTO vecs SELECT 100000 + i, l2_normalize(q.v + (SELECT array_agg((random() - 0.5) * 0.3) FROM generate_series(1, 1024) WHERE i > 0)::vector(1024))
  FROM generate_series(1, 2000) i JOIN queries q ON q.q = 1 + i % 20;
ANALYZE;
CREATE TABLE after AS SELECT q.q, hnsw_top(q.v, 50) AS h, exact_top(q.v, 50) AS e FROM queries q;
SELECT 'hnsw list changed by hidden rows (queries of 20)' AS what, count(*) FILTER (WHERE b.h IS DISTINCT FROM a.h) AS n FROM before b JOIN after a USING (q)
UNION ALL SELECT 'hnsw set changed by hidden rows', count(*) FILTER (WHERE (SELECT array_agg(x ORDER BY x) FROM unnest(b.h) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(a.h) x)) FROM before b JOIN after a USING (q)
UNION ALL SELECT 'hnsw list differs from exact (after)', count(*) FILTER (WHERE a.h IS DISTINCT FROM a.e) FROM after a
UNION ALL SELECT 'exact list changed by hidden rows', count(*) FILTER (WHERE b.e IS DISTINCT FROM a.e) FROM before b JOIN after a USING (q)
UNION ALL SELECT 'hnsw rows returned < 50 (after)', count(*) FILTER (WHERE cardinality(a.h) < 50) FROM after a;
SELECT q, cardinality(ARRAY(SELECT unnest(b.h) EXCEPT SELECT unnest(a.h))) AS rows_swapped FROM before b JOIN after a USING (q) WHERE b.h IS DISTINCT FROM a.h ORDER BY q LIMIT 10;
-- Cost of the exact list at 10,000 visible vectors.
\timing on
SELECT cardinality(exact_top(v, 50)) FROM queries WHERE q = 3;
SELECT cardinality(exact_top(v, 50)) FROM queries WHERE q = 4;
SELECT cardinality(hnsw_top(v, 50)) FROM queries WHERE q = 4;
