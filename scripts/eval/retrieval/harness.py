#!/usr/bin/env python3
"""The retrieval bench (#1242): loads the seeded space, builds every option's index, and measures recall@10, query latency, index
size, write overhead, and whether access loss and deletion take effect at once. Runs in the `harness` container of compose.yaml
(see run.sh); every engine there is limited to the same two CPUs.

  python harness.py load index recall write access tokens deletion --out out/results.json
  python harness.py <step> ...                        # load | embed | index | recall | write | access | tokens

Options (the `variant` names in the results):
  window40      today's API brief: the last 40 messages of the place the question is asked in (no search)
  today         today's search_documents + flux_search_project: `simple` tsvector, web-search AND of the words, one space
  fts_or        simple + unaccent, OR of the words, ts_rank (no IDF), every readable space
  fts_lang      Polish Hunspell + English stems + stop words, plus simple+unaccent, OR of the words, ts_rank
  trgm          pg_trgm word similarity per query word (typos)
  bm25          ParadeDB pg_search BM25, Polish stemmer, ASCII folding, OR of the words
  vec           pgvector HNSW over local embeddings (BENCH_EMBED_MODEL, via text-embeddings-inference)
  hybrid_lang   reciprocal rank fusion (k=60) of fts_lang and vec, top 50 each
  hybrid_bm25   reciprocal rank fusion of bm25 and vec
  meili         Meilisearch keyword search, readable spaces passed as a filter
  meili_hybrid  Meilisearch hybrid (semanticRatio 0.5) over the same vectors (userProvided embedder)
"""
import argparse
import hashlib
import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx
import psycopg

HERE = Path(__file__).resolve().parent
DB = os.environ.get("BENCH_DB", "postgresql://bench:bench@127.0.0.1:25910/bench")
EMBED = os.environ.get("BENCH_EMBED", "http://127.0.0.1:25911")
MEILI = os.environ.get("BENCH_MEILI", "http://127.0.0.1:25912")
MEILI_KEY = "bench-master-key-0123456789"
MODEL = os.environ.get("BENCH_EMBED_MODEL", "intfloat/multilingual-e5-small")
E5 = "e5" in MODEL.lower()
VECTORS = HERE / "out" / ("vectors-" + MODEL.replace("/", "_") + ".json")
K = 10
DEEP = 50  # each list's depth before fusion
VARIANTS = ["window40", "today", "fts_or", "fts_lang", "trgm", "bm25", "vec", "hybrid_lang", "hybrid_bm25", "meili", "meili_hybrid"]
SEARCHERS = [v for v in VARIANTS if v != "window40"]


def seed():
    return json.loads((HERE / "out" / "seed.json").read_text())


def connect():
    # No server-side prepared statements, as Flux (node-postgres via Drizzle) sends them: a generic plan would also drop ParadeDB's scan.
    return psycopg.connect(DB, autocommit=True, prepare_threshold=None)


def pct(values, p):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


# ---------------------------------------------------------------- embeddings

def embed(texts, kind):
    prefix = ("query: " if kind == "query" else "passage: ") if E5 else ""
    response = httpx.post(f"{EMBED}/embed", json={"inputs": [prefix + t for t in texts], "normalize": True, "truncate": True}, timeout=300)
    response.raise_for_status()
    return response.json()


def vector_literal(v):
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


# ---------------------------------------------------------------- load and index

def step_load(data, results):
    with connect() as db:
        db.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        db.execute((HERE / "schema.sql").read_text())
        for p in data["people"]:
            db.execute("INSERT INTO people (id, key, name, role) VALUES (%s, %s, %s, %s)", (p["id"], p["key"], p["name"], p["role"]))
        people = {p["key"]: p["id"] for p in data["people"]}
        for a in data["agents"]:
            db.execute("INSERT INTO agents (id, key, owner) VALUES (%s, %s, %s)", (a["id"], a["key"], people[a["owner"]]))
        spaces = {}
        for s in data["spaces"]:
            spaces[s["key"]] = s["id"]
            db.execute("INSERT INTO spaces (id, key, name, visibility) VALUES (%s, %s, %s, %s)", (s["id"], s["key"], s["name"], s["visibility"]))
            for person, role in s["grants"].items():
                db.execute("INSERT INTO grants VALUES (%s, %s, %s)", (s["id"], people[person], role))
        convs = {}
        for c in data["conversations"]:
            convs[c["key"]] = c["id"]
            db.execute("INSERT INTO conversations VALUES (%s, %s, %s)", (c["id"], c["key"], spaces[c["space"]]))
        start = time.perf_counter()
        with db.cursor().copy("COPY messages (id, space_id, conversation_id, sequence, author, created_at, body, lang) FROM STDIN") as copy:
            for m in data["messages"]:
                copy.write_row((m["id"], spaces[m["space"]], convs[m["conversation"]], m["sequence"], people[m["author"]], m["at"], m["body"], m["lang"]))
        db.execute("ANALYZE messages")
        results["load"] = {"messages": len(data["messages"]), "copy_s": round(time.perf_counter() - start, 2),
                           "table_bytes": db.execute("SELECT pg_total_relation_size('messages')").fetchone()[0]}
    print("load", results["load"])


INDEX_SQL = {
    "today": """
      CREATE TABLE sd_today (id bigserial PRIMARY KEY, doc_key text UNIQUE NOT NULL, audience_key text NOT NULL, space_id uuid NOT NULL,
        object_id uuid NOT NULL, body text NOT NULL, at timestamptz NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', ''), 'A') || setweight(to_tsvector('simple', left(body, 100000)), 'B')) STORED,
        keys bigint[] GENERATED ALWAYS AS (search_keys(audience_key, '', body)) STORED);
      CREATE INDEX sd_today_keys_idx ON sd_today USING gin (keys) WITH (fastupdate = off);
      CREATE FUNCTION sd_today_index() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN DELETE FROM sd_today WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
        IF NEW.removed_at IS NOT NULL THEN DELETE FROM sd_today WHERE doc_key = 'message:' || NEW.id; RETURN NEW; END IF;
        INSERT INTO sd_today (doc_key, audience_key, space_id, object_id, body, at)
        VALUES ('message:' || NEW.id, 'project:' || NEW.space_id, NEW.space_id, NEW.id, NEW.body, NEW.created_at)
        ON CONFLICT (doc_key) DO UPDATE SET body = EXCLUDED.body, audience_key = EXCLUDED.audience_key, space_id = EXCLUDED.space_id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sd_today_index AFTER INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION sd_today_index();
      INSERT INTO sd_today (doc_key, audience_key, space_id, object_id, body, at)
        SELECT 'message:' || id, 'project:' || space_id, space_id, id, body, created_at FROM messages WHERE removed_at IS NULL;
    """,
    "fts_or": """
      ALTER TABLE messages ADD COLUMN tsv_simple tsvector GENERATED ALWAYS AS (to_tsvector('simple_unaccent', body)) STORED;
      CREATE INDEX messages_tsv_simple_idx ON messages USING gin (tsv_simple);
    """,
    "fts_lang": """
      ALTER TABLE messages ADD COLUMN tsv_lang tsvector GENERATED ALWAYS AS (to_tsvector('pl_en', body) || to_tsvector('simple_unaccent', body)) STORED;
      CREATE INDEX messages_tsv_lang_idx ON messages USING gin (tsv_lang);
    """,
    "trgm": "CREATE INDEX messages_trgm_idx ON messages USING gin (f_unaccent(body) gin_trgm_ops);",
    "bm25": """
      CREATE INDEX messages_bm25_idx ON messages USING bm25 (id, (body::pdb.simple('ascii_folding=true', 'stemmer=polish')), space_id, created_at)
        WITH (key_field = 'id');
    """,
    "vec": """
      CREATE TABLE message_embeddings (message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE, model text NOT NULL,
        body_hash text NOT NULL, embedding vector(%(dim)s) NOT NULL);
      CREATE TABLE embedding_queue (message_id uuid PRIMARY KEY, queued_at timestamptz NOT NULL DEFAULT now());
      -- An edit or a removal drops the message's vector in the writer's transaction; a job embeds the new words later.
      CREATE FUNCTION embedding_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.removed_at IS NOT NULL OR NEW.body IS DISTINCT FROM OLD.body THEN
          DELETE FROM message_embeddings WHERE message_id = NEW.id;
          IF NEW.removed_at IS NULL THEN INSERT INTO embedding_queue (message_id) VALUES (NEW.id) ON CONFLICT DO NOTHING; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER embedding_invalidate AFTER UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION embedding_invalidate();
    """,
    "summaries": """
      -- Option D's records: a summary covers a run of one conversation's messages and lists them. Any edit, removal or deletion
      -- of a covered message marks it stale in the writer's transaction; readers never get a stale summary.
      CREATE TABLE conversation_summaries (id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations,
        from_sequence int NOT NULL, to_sequence int NOT NULL, source_ids uuid[] NOT NULL, body text NOT NULL, stale boolean NOT NULL DEFAULT false);
      CREATE INDEX conversation_summaries_sources_idx ON conversation_summaries USING gin (source_ids);
      CREATE FUNCTION summaries_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE gone uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.removed_at IS NOT NULL OR NEW.body IS DISTINCT FROM OLD.body THEN
          UPDATE conversation_summaries SET stale = true WHERE source_ids @> ARRAY[gone] AND NOT stale;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$;
      CREATE TRIGGER summaries_invalidate AFTER UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION summaries_invalidate();
    """,
}


def step_index(data, results):
    """Builds each PostgreSQL structure and times it; embeds every message; loads Meilisearch."""
    out = results.setdefault("index", {})
    with connect() as db:
        for name in ("today", "fts_or", "fts_lang", "trgm", "bm25", "summaries"):
            start = time.perf_counter()
            db.execute(INDEX_SQL[name])
            out[name] = {"build_s": round(time.perf_counter() - start, 2)}
            print("index", name, out[name])
        db.execute("ANALYZE messages")
        size = lambda sql: db.execute(sql).fetchone()[0]
        out["today"]["bytes"] = size("SELECT pg_total_relation_size('sd_today')")
        out["fts_or"]["bytes"] = size("SELECT sum(pg_column_size(tsv_simple)) + pg_relation_size('messages_tsv_simple_idx') FROM messages")
        out["fts_lang"]["bytes"] = size("SELECT sum(pg_column_size(tsv_lang)) + pg_relation_size('messages_tsv_lang_idx') FROM messages")
        out["trgm"]["bytes"] = size("SELECT pg_relation_size('messages_trgm_idx')")
        out["bm25"]["bytes"] = size("SELECT pg_relation_size('messages_bm25_idx')")
        # Polish dictionary: memory per connection and the first use's cost.
        with psycopg.connect(DB, autocommit=True) as fresh:
            start = time.perf_counter(); fresh.execute("SELECT to_tsvector('pl_en', 'czujnikami')"); first = time.perf_counter() - start
            start = time.perf_counter(); fresh.execute("SELECT to_tsvector('pl_en', 'obudowami')"); second = time.perf_counter() - start
            mem = fresh.execute("SELECT sum(total_bytes) FROM pg_backend_memory_contexts").fetchone()[0]
        with psycopg.connect(DB, autocommit=True) as plain:
            plain.execute("SELECT to_tsvector('simple', 'czujnikami')")
            base = plain.execute("SELECT sum(total_bytes) FROM pg_backend_memory_contexts").fetchone()[0]
        out["fts_lang"]["dictionary_first_use_ms"] = round(first * 1000, 1)
        out["fts_lang"]["dictionary_later_use_ms"] = round(second * 1000, 2)
        out["fts_lang"]["dictionary_backend_bytes"] = int(mem - base)

        # Embeddings: the model's dimension, then all messages in batches (as a backfill job would), then the HNSW index.
        dim = len(embed(["probe"], "passage")[0])
        db.execute(INDEX_SQL["vec"] % {"dim": dim})
        rows = db.execute("SELECT id, body FROM messages ORDER BY created_at").fetchall()
        start = time.perf_counter()
        vectors = {}
        for i in range(0, len(rows), 32):
            batch = rows[i:i + 32]
            for (mid, body), v in zip(batch, embed([b for _, b in batch], "passage")):
                vectors[str(mid)] = v
        embed_s = time.perf_counter() - start
        with db.cursor().copy("COPY message_embeddings (message_id, model, body_hash, embedding) FROM STDIN") as copy:
            for mid, body in rows:
                copy.write_row((mid, MODEL, hashlib.sha256(body.encode()).hexdigest()[:16], vector_literal(vectors[str(mid)])))
        start = time.perf_counter()
        db.execute("CREATE INDEX message_embeddings_hnsw_idx ON message_embeddings USING hnsw (embedding vector_cosine_ops)")
        hnsw_s = time.perf_counter() - start
        db.execute("ANALYZE message_embeddings")
        single = []
        for _, body in rows[:60]:
            s = time.perf_counter(); embed([body], "passage"); single.append(time.perf_counter() - s)
        out["vec"] = {"model": MODEL, "dim": dim, "embed_all_s": round(embed_s, 1), "embed_per_s": round(len(rows) / embed_s, 1),
                      "embed_one_ms_p50": round(pct(single, 50) * 1000, 1), "embed_one_ms_p95": round(pct(single, 95) * 1000, 1),
                      "hnsw_build_s": round(hnsw_s, 2), "bytes": size("SELECT pg_total_relation_size('message_embeddings')"),
                      "hnsw_bytes": size("SELECT pg_relation_size('message_embeddings_hnsw_idx')")}
        print("index vec", out["vec"])
        VECTORS.write_text(json.dumps({"model": MODEL, "vectors": vectors}))

        # Meilisearch: one index, the readable-space filter and dates filterable, vectors user-provided.
        meili_load(db, vectors, dim, out)


def meili(method, path, **kw):
    response = httpx.request(method, f"{MEILI}{path}", headers={"Authorization": f"Bearer {MEILI_KEY}"}, timeout=120, **kw)
    if response.status_code >= 400:
        raise RuntimeError(f"meili {method} {path}: {response.status_code} {response.text[:300]}")
    return response.json() if response.content else None


def meili_wait(task):
    uid = task["taskUid"]
    while True:
        t = meili("GET", f"/tasks/{uid}")
        if t["status"] in ("succeeded", "failed", "canceled"):
            if t["status"] != "succeeded":
                raise RuntimeError(f"meili task {uid}: {t}")
            return t
        time.sleep(0.005)


def meili_doc(row, vector):
    mid, space, conv, at, body = row
    return {"id": str(mid), "space_id": str(space), "conversation_id": str(conv), "at": int(at.timestamp()), "body": body,
            "_vectors": {"local": vector}}


def meili_load(db, vectors, dim, out):
    try:
        meili_wait(meili("DELETE", "/indexes/messages"))
    except RuntimeError:
        pass
    meili_wait(meili("POST", "/indexes", json={"uid": "messages", "primaryKey": "id"}))
    meili_wait(meili("PATCH", "/indexes/messages/settings", json={
        "searchableAttributes": ["body"], "filterableAttributes": ["space_id", "at"], "sortableAttributes": ["at"],
        "localizedAttributes": [{"attributePatterns": ["body"], "locales": ["pol", "eng"]}],
        "embedders": {"local": {"source": "userProvided", "dimensions": dim}}}))
    rows = db.execute("SELECT id, space_id, conversation_id, created_at, body FROM messages WHERE removed_at IS NULL").fetchall()
    start = time.perf_counter()
    for i in range(0, len(rows), 1000):
        last = meili("POST", "/indexes/messages/documents", json=[meili_doc(r, vectors[str(r[0])]) for r in rows[i:i + 1000]])
    meili_wait(last)
    stats = meili("GET", "/stats")
    out["meili"] = {"build_s": round(time.perf_counter() - start, 1), "bytes": stats["databaseSize"],
                    "used_bytes": stats.get("usedDatabaseSize")}
    print("index meili", out["meili"])


# ---------------------------------------------------------------- the searches

def principal_of(data, kind, key):
    if kind == "agent":
        return ("agent", next(a["id"] for a in data["agents"] if a["key"] == key))
    return ("human", next(p["id"] for p in data["people"] if p["key"] == key))


READABLE = "r AS MATERIALIZED (SELECT readable_spaces(%(pk)s, %(pid)s) AS id)"
FILTERS = """m.space_id IN (SELECT id FROM r) AND m.removed_at IS NULL
  AND (%(after)s::timestamptz IS NULL OR m.created_at >= %(after)s::timestamptz)
  AND (%(before)s::timestamptz IS NULL OR m.created_at < %(before)s::timestamptz)"""
OR_QUERY = "(SELECT to_tsquery(%(cfg)s, coalesce(nullif(string_agg(quote_literal(lexeme), ' | '), ''), quote_literal('')))" \
           " FROM unnest(to_tsvector(%(cfg)s, %(q)s)))"
LANG_QUERY = "(SELECT to_tsquery('simple', coalesce(nullif(string_agg(DISTINCT quote_literal(lexeme), ' | '), ''), quote_literal('')))" \
             " FROM unnest(to_tsvector('pl_en', %(q)s) || to_tsvector('simple_unaccent', %(q)s)))"


def sql_for(variant):
    if variant == "today":
        # pageStatement of packages/db/src/repositories/search.ts for messages (titles are empty): one space, AND of the words.
        return """
        WITH r AS MATERIALIZED (SELECT readable_spaces(%(pk)s, %(pid)s) AS id),
        qq AS (SELECT CASE WHEN %(prefix)s::text IS NULL THEN websearch_to_tsquery('simple', %(q)s)
                      ELSE websearch_to_tsquery('simple', %(q)s) || to_tsquery('simple', %(prefix)s) END AS q),
        aud AS MATERIALIZED (SELECT v.keys, ARRAY(SELECT search_key(key, term) FROM unnest(v.keys) AS key
            CROSS JOIN unnest(ARRAY(SELECT DISTINCT search_term(lexeme) FROM unnest(to_tsvector('simple', %(q)s || ' ' || %(words)s)))) AS term) AS lookups
          FROM (SELECT ARRAY(SELECT 'project:' || id FROM r) AS keys) v)
        SELECT sd.object_id FROM sd_today sd, qq
        WHERE sd.keys && (SELECT lookups FROM aud) AND sd.audience_key = ANY ((SELECT keys FROM aud)::text[])
          AND sd.space_id = %(place)s::uuid AND sd.tsv @@ qq.q
        ORDER BY ts_rank(sd.tsv, qq.q) DESC, sd.at DESC, sd.id DESC LIMIT %(k)s"""
    if variant == "fts_or":
        return f"""WITH {READABLE}, qq AS (SELECT {OR_QUERY.replace('%(cfg)s', "'simple_unaccent'")} AS q)
        SELECT m.id FROM messages m, qq WHERE m.tsv_simple @@ qq.q AND {FILTERS}
        ORDER BY ts_rank(m.tsv_simple, qq.q) DESC, m.created_at DESC LIMIT %(k)s"""
    if variant == "fts_lang":
        return f"""WITH {READABLE}, qq AS (SELECT {LANG_QUERY} AS q)
        SELECT m.id FROM messages m, qq WHERE m.tsv_lang @@ qq.q AND {FILTERS}
        ORDER BY ts_rank(m.tsv_lang, qq.q) DESC, m.created_at DESC LIMIT %(k)s"""
    if variant == "trgm":
        return f"""WITH {READABLE}, w AS (SELECT DISTINCT f_unaccent(x) AS w FROM regexp_split_to_table(%(q)s, '[^[:alnum:]]+') x WHERE length(x) >= 4)
        SELECT m.id FROM messages m JOIN w ON w.w <%% f_unaccent(m.body) WHERE {FILTERS}
        GROUP BY m.id, m.created_at ORDER BY sum(word_similarity(w.w, f_unaccent(m.body))) DESC, m.created_at DESC LIMIT %(k)s"""
    if variant == "bm25":
        return f"""WITH {READABLE}
        SELECT m.id FROM messages m WHERE m.body ||| %(q)s AND {FILTERS}
        ORDER BY pdb.score(m.id) DESC, m.created_at DESC LIMIT %(k)s"""
    if variant == "vec":
        return f"""WITH {READABLE}
        SELECT m.id FROM message_embeddings e JOIN messages m ON m.id = e.message_id WHERE {FILTERS}
        ORDER BY e.embedding <=> %(qv)s::vector LIMIT %(k)s"""
    if variant in ("hybrid_lang", "hybrid_bm25"):
        if variant == "hybrid_lang":
            keyword = f"""SELECT m.id, row_number() OVER (ORDER BY ts_rank(m.tsv_lang, qq.q) DESC, m.created_at DESC) AS rk
              FROM messages m, qq WHERE m.tsv_lang @@ qq.q AND {FILTERS} ORDER BY rk LIMIT {DEEP}"""
            pre = f", qq AS (SELECT {LANG_QUERY} AS q)"
        else:
            keyword = f"""SELECT m.id, row_number() OVER (ORDER BY pdb.score(m.id) DESC, m.created_at DESC) AS rk
              FROM messages m WHERE m.body ||| %(q)s AND {FILTERS} ORDER BY rk LIMIT {DEEP}"""
            pre = ""
        return f"""WITH {READABLE}{pre},
        kw AS ({keyword}),
        vv AS (SELECT id, row_number() OVER () AS rk FROM (SELECT m.id FROM message_embeddings e JOIN messages m ON m.id = e.message_id
               WHERE {FILTERS} ORDER BY e.embedding <=> %(qv)s::vector LIMIT {DEEP}) x)
        SELECT id FROM (SELECT id, rk FROM kw UNION ALL SELECT id, rk FROM vv) both_lists
        GROUP BY id ORDER BY sum(1.0 / (60 + rk)) DESC LIMIT %(k)s"""
    raise KeyError(variant)


class Searcher:
    def __init__(self, data):
        self.data = data
        self.db = connect()
        self.db.execute("SET hnsw.ef_search = 100")
        self.db.execute("SET hnsw.iterative_scan = relaxed_order")
        self.space_of_conv = {c["key"]: next(s["id"] for s in data["spaces"] if s["key"] == c["space"]) for c in data["conversations"]}
        self.qv_cache = {}

    def query_vector(self, text):
        if text not in self.qv_cache:
            self.qv_cache[text] = vector_literal(embed([text], "query")[0])
        return self.qv_cache[text]

    def search(self, variant, principal, text, place=None, after=None, before=None, k=K, cached_vector=True):
        """Ids of the best k visible messages, and the seconds spent (query embedding included for vector variants)."""
        start = time.perf_counter()
        params = {"pk": principal[0], "pid": principal[1], "q": text, "after": after, "before": before, "k": k}
        if variant in ("vec", "hybrid_lang", "hybrid_bm25", "meili_hybrid"):
            if not cached_vector:
                self.qv_cache.pop(text, None)
            params["qv"] = self.query_vector(text)
        if variant.startswith("meili"):
            ids = self.meili_search(variant, params)
        else:
            if variant == "today":
                words = [w.lower() for w in __import__("re").findall(r"[^\W_]+", text)]
                params["words"] = " ".join(words)
                params["prefix"] = " & ".join(words[-12:-1] + [words[-1] + ":*"]) if words and text[-1:].isalnum() else None
                params["place"] = place
                with self.db.transaction():
                    self.db.execute("SET LOCAL enable_seqscan = off")
                    rows = self.db.execute(sql_for(variant), params).fetchall()
            else:
                rows = self.db.execute(sql_for(variant), params).fetchall()
            ids = [str(r[0]) for r in rows]
        return ids, time.perf_counter() - start

    def meili_search(self, variant, params):
        readable = [str(r[0]) for r in self.db.execute("SELECT readable_spaces(%(pk)s, %(pid)s)", params).fetchall()]
        if not readable:
            return []
        clauses = ["space_id IN [" + ", ".join(f'"{s}"' for s in readable) + "]"]
        if params["after"]:
            clauses.append(f"at >= {int(time.mktime(time.strptime(params['after'], '%Y-%m-%d')))}")
        if params["before"]:
            clauses.append(f"at < {int(time.mktime(time.strptime(params['before'], '%Y-%m-%d')))}")
        # "frequency" drops the most common query words first; the default ("last") keeps the first word, so a question that
        # starts with a word no message has ("Jaki", "Which") finds nothing.
        body = {"q": params["q"], "filter": " AND ".join(clauses), "limit": params["k"], "attributesToRetrieve": ["id"],
                "matchingStrategy": "frequency"}
        if variant == "meili_hybrid":
            body["vector"] = json.loads(params["qv"])
            body["hybrid"] = {"embedder": "local", "semanticRatio": 0.5}
        return [h["id"] for h in meili("POST", "/indexes/messages/search", json=body)["hits"]]

    def window(self, conv_key):
        conv = next(c["id"] for c in self.data["conversations"] if c["key"] == conv_key)
        rows = self.db.execute("""SELECT id FROM (SELECT id, sequence FROM messages WHERE conversation_id = %s AND removed_at IS NULL
          ORDER BY sequence DESC LIMIT 40) x ORDER BY sequence""", (conv,)).fetchall()
        return [str(r[0]) for r in rows]


# ---------------------------------------------------------------- recall and latency

def step_recall(data, results, repeats=3):
    s = Searcher(data)
    agent = principal_of(data, "agent", "fieldbot")
    out = {}
    for variant in VARIANTS:
        for mode in ("question", "keywords", "bilingual"):
            per_q, times, cats = [], [], {}
            for q in data["questions"]:
                # bilingual: the keywords plus their literal translation, one query (what an agent told to search in both
                # languages would send); written by hand in facts.json, so it simulates the agent rather than measuring one.
                text = q["keywords"] + " " + q["keywords_other"] if mode == "bilingual" else q[mode]
                if variant == "window40":
                    ids, took = s.window(q["asked_in"]), 0.0
                else:
                    place = s.space_of_conv[q["asked_in"]]
                    ids, took = s.search(variant, agent, text, place=place, after=q.get("after"), before=q.get("before"))
                    for _ in range(repeats):
                        times.append(s.search(variant, agent, text, place=place, after=q.get("after"), before=q.get("before"))[1])
                found = len(set(ids[:K if variant != "window40" else 40]) & set(q["gold_ids"])) / len(q["gold_ids"])
                rank = next((i + 1 for i, x in enumerate(ids) if x in q["gold_ids"]), None)
                per_q.append({"id": q["id"], "recall": found, "rank": rank, "returned": len(ids)})
                cats.setdefault(q["category"], []).append(found)
            entry = {"recall": round(statistics.mean(x["recall"] for x in per_q), 3),
                     "mrr": round(statistics.mean(1 / x["rank"] if x["rank"] else 0 for x in per_q), 3),
                     "empty": sum(1 for x in per_q if x["returned"] == 0),
                     "by_category": {c: round(statistics.mean(v), 2) for c, v in sorted(cats.items())},
                     "per_question": per_q}
            if times:
                entry.update({"p50_ms": round(pct(times, 50) * 1000, 1), "p95_ms": round(pct(times, 95) * 1000, 1)})
            out.setdefault(variant, {})[mode] = entry
            print(f"recall {variant:13s} {mode:9s} r@10={entry['recall']:.3f} mrr={entry['mrr']:.3f} empty={entry['empty']:2d} "
                  f"p95={entry.get('p95_ms', '-')} {entry['by_category']}")
    # Query embedding latency alone (uncached), the part vector options add to each search.
    qtimes = []
    for q in data["questions"]:
        start = time.perf_counter(); embed([q["question"]], "query"); qtimes.append(time.perf_counter() - start)
    results["query_embed_ms"] = {"p50": round(pct(qtimes, 50) * 1000, 1), "p95": round(pct(qtimes, 95) * 1000, 1)}
    results["recall"] = out


# ---------------------------------------------------------------- write overhead

WRITE_VARIANTS = ["none", "today", "fts_lang", "trgm", "bm25", "vec_row", "all_pg"]


def step_write(data, results, n=400):
    """Each variant gets a copy of the 10k messages with only its own index, then n single-row inserts, one transaction each."""
    vectors = json.loads(VECTORS.read_text())["vectors"]
    sample = list(vectors.values())[:n]
    out = {}
    with connect() as db:
        dim = len(sample[0])
        for variant in WRITE_VARIANTS:
            db.execute("DROP TABLE IF EXISTS w_messages CASCADE; DROP TABLE IF EXISTS w_sd CASCADE; DROP TABLE IF EXISTS w_emb CASCADE; DROP FUNCTION IF EXISTS w_sd_index CASCADE")
            db.execute("""CREATE TABLE w_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL, conversation_id uuid NOT NULL,
              sequence int NOT NULL, author text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), body text NOT NULL, removed_at timestamptz)""")
            db.execute("INSERT INTO w_messages SELECT id, space_id, conversation_id, sequence, author, created_at, body, NULL FROM messages")
            if variant in ("today", "all_pg"):
                db.execute(INDEX_SQL["today"].replace("sd_today", "w_sd").replace("ON messages", "ON w_messages").replace("FROM messages", "FROM w_messages"))
            if variant in ("fts_lang", "all_pg"):
                db.execute(INDEX_SQL["fts_lang"].replace("messages", "w_messages").replace("w_messages_tsv_lang_idx", "w_tsv_idx"))
            if variant in ("trgm", "all_pg"):
                db.execute("CREATE INDEX w_trgm_idx ON w_messages USING gin (f_unaccent(body) gin_trgm_ops)")
            if variant in ("bm25", "all_pg"):
                db.execute("CREATE INDEX w_bm25_idx ON w_messages USING bm25 (id, (body::pdb.simple('ascii_folding=true', 'stemmer=polish')), space_id, created_at) WITH (key_field = 'id')")
            if variant in ("vec_row", "all_pg"):
                db.execute(f"CREATE TABLE w_emb (message_id uuid PRIMARY KEY REFERENCES w_messages ON DELETE CASCADE, embedding vector({dim}) NOT NULL)")
                db.execute("INSERT INTO w_emb SELECT message_id, embedding FROM message_embeddings")
                db.execute("CREATE INDEX w_emb_hnsw ON w_emb USING hnsw (embedding vector_cosine_ops)")
            db.execute("VACUUM ANALYZE w_messages")
            space, conv = db.execute("SELECT space_id, conversation_id FROM messages LIMIT 1").fetchone()
            bodies = [m["body"] for m in data["messages"][:n]]
            times, statements = [], []
            for i, body in enumerate(bodies):
                start = time.perf_counter()
                with db.transaction():
                    s0 = time.perf_counter()
                    mid = db.execute("INSERT INTO w_messages (space_id, conversation_id, sequence, author, body) VALUES (%s, %s, %s, 'x', %s) RETURNING id",
                                     (space, conv, 100000 + i, body + f" #{i}")).fetchone()[0]
                    if variant in ("vec_row", "all_pg"):
                        # The job's write, after the model ran: one row into the HNSW index (the model's time is measured apart).
                        db.execute("INSERT INTO w_emb VALUES (%s, %s::vector)", (mid, vector_literal(sample[i])))
                    statements.append(time.perf_counter() - s0)
                times.append(time.perf_counter() - start)
            # With the commit (what the API waits for; its WAL flush dominates) and the statements alone (the index's own work).
            out[variant] = {"mean_ms": round(statistics.mean(times) * 1000, 2), "p95_ms": round(pct(times, 95) * 1000, 2),
                            "statement_mean_ms": round(statistics.mean(statements) * 1000, 3),
                            "statement_p95_ms": round(pct(statements, 95) * 1000, 3)}
            print("write", variant, out[variant])
        db.execute("DROP TABLE IF EXISTS w_messages CASCADE; DROP TABLE IF EXISTS w_sd CASCADE; DROP TABLE IF EXISTS w_emb CASCADE")
    # Meilisearch: one document at a time, from the request until it is searchable (its task succeeded).
    lat = []
    for i in range(60):
        doc = {"id": f"w{i}", "space_id": "none", "conversation_id": "none", "at": 0, "body": data["messages"][i]["body"], "_vectors": {"local": sample[i]}}
        start = time.perf_counter(); meili_wait(meili("POST", "/indexes/messages/documents", json=[doc])); lat.append(time.perf_counter() - start)
    meili_wait(meili("POST", "/indexes/messages/documents/delete-batch", json=[f"w{i}" for i in range(60)]))
    out["meili_visible"] = {"mean_ms": round(statistics.mean(lat) * 1000, 1), "p95_ms": round(pct(lat, 95) * 1000, 1)}
    print("write meili", out["meili_visible"])
    results["write"] = out


# ---------------------------------------------------------------- access loss and deletion

def found(s, variant, principal, text, fact_id):
    ids, _ = s.search(variant, principal, text, k=50)
    return fact_id in ids


ACCESS_CHANGES = {
    "revoke_grant": ("DELETE FROM grants WHERE space_id = %(space)s AND person_id = %(person)s",
                     "INSERT INTO grants VALUES (%(space)s, %(person)s, 'contributor')"),
    "ai_off": ("UPDATE spaces SET ai_allowed = false WHERE id = %(space)s", "UPDATE spaces SET ai_allowed = true WHERE id = %(space)s"),
    "remove_member": ("UPDATE people SET active = false WHERE id = %(person)s", "UPDATE people SET active = true WHERE id = %(person)s"),
}


def step_access(data, results):
    s = Searcher(data)
    facts = data["facts"]
    spaces = {x["key"]: x["id"] for x in data["spaces"]}
    people = {x["key"]: x["id"] for x in data["people"]}
    out = {}
    for check in data["access_checks"]:
        principal = principal_of(data, "agent", check["agent"]) if "agent" in check else principal_of(data, "human", check["person"])
        args = {"space": spaces[check["space"]], "person": people.get(check.get("person", ""))}
        row = {}
        for variant in SEARCHERS:
            if variant == "today":
                continue  # one space per call; covered by the same readable_spaces rule
            before = found(s, variant, principal, check["query"], facts[check["fact"]])
            if check["change"] != "none":
                s.db.execute(ACCESS_CHANGES[check["change"]][0], args)
            after = found(s, variant, principal, check["query"], facts[check["fact"]])
            if check["change"] != "none":
                s.db.execute(ACCESS_CHANGES[check["change"]][1], args)
            ok = (before and not after) if check["change"] != "none" else (not before and not after)
            row[variant] = {"found_before": before, "found_after": after, "ok": ok}
        out[check["id"]] = {"what": check["what"], "results": row}
        print("access", check["id"], {v: r["ok"] for v, r in row.items()})
    results["access"] = out


def recheck(s, principal, ids):
    """Keeps the engine's hits that PostgreSQL still has, not removed, in a space the principal reads now (one statement)."""
    if not ids:
        return ids
    keep = {str(r[0]) for r in s.db.execute("""SELECT id FROM messages WHERE id = ANY(%s::uuid[]) AND removed_at IS NULL
      AND space_id IN (SELECT readable_spaces(%s, %s))""", (ids, principal[0], principal[1])).fetchall()}
    return [i for i in ids if i in keep]


def restore(s, data, mid, original):
    """Puts the fact's message back as seeded in every index, and makes the summaries fresh again."""
    m = next(x for x in data["messages"] if x["id"] == mid)
    exists = s.db.execute("SELECT 1 FROM messages WHERE id = %s", (mid,)).fetchone()
    if exists:
        s.db.execute("UPDATE messages SET removed_at = NULL, edited_at = NULL, body = %s WHERE id = %s", (original, mid))
    else:
        s.db.execute("""INSERT INTO messages (id, space_id, conversation_id, sequence, author, created_at, body, lang)
          SELECT %s, c.space_id, c.id, %s, p.id, %s, %s, %s FROM conversations c, people p WHERE c.key = %s AND p.key = %s""",
                     (mid, m["sequence"], m["at"], original, m["lang"], m["conversation"], m["author"]))
    vector = embed([original], "passage")[0]
    s.db.execute("""INSERT INTO message_embeddings (message_id, model, body_hash, embedding) VALUES (%s, %s, 'seed', %s::vector)
      ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding""", (mid, MODEL, vector_literal(vector)))
    s.db.execute("DELETE FROM embedding_queue WHERE message_id = %s", (mid,))
    s.db.execute("UPDATE conversation_summaries SET stale = false WHERE source_ids @> ARRAY[%s::uuid]", (mid,))
    space, conv, at = s.db.execute("SELECT space_id, conversation_id, created_at FROM messages WHERE id = %s", (mid,)).fetchone()
    meili_wait(meili("POST", "/indexes/messages/documents", json=[meili_doc((mid, space, conv, at, original), vector)]))


def step_deletion(data, results):
    """Destructive: run last. Each check changes the fact's message in PostgreSQL, queries every option at once, then (for
    Meilisearch) applies the change to the engine as an indexing job would and measures how long the old text stays findable."""
    s = Searcher(data)
    agent = principal_of(data, "agent", "fieldbot")
    facts = data["facts"]
    out = {}
    # Option D's records for the checks: a summary per 100 messages of each conversation (placeholder text, not a model's).
    s.db.execute("TRUNCATE conversation_summaries")
    s.db.execute("""INSERT INTO conversation_summaries (conversation_id, from_sequence, to_sequence, source_ids, body)
      SELECT conversation_id, min(sequence), max(sequence), array_agg(id ORDER BY sequence), left(string_agg(body, ' ' ORDER BY sequence), 600)
      FROM messages GROUP BY conversation_id, (sequence - 1) / 100""")
    for check in data["deletion_checks"]:
        mid = facts[check["fact"]]
        seeded = next(m for m in data["messages"] if m["id"] == mid)
        restore(s, data, mid, seeded["body"])
        row = {v: {"found_before": found(s, v, agent, check["query"], mid)} for v in SEARCHERS if v != "today"}
        summary_before = s.db.execute("SELECT count(*) FROM conversation_summaries WHERE NOT stale AND source_ids @> ARRAY[%s::uuid]", (mid,)).fetchone()[0]
        edited = seeded["edited_body"]
        if check["change"] == "remove":
            s.db.execute("UPDATE messages SET removed_at = now(), body = 'This message was deleted.' WHERE id = %s", (mid,))
        elif check["change"] == "delete":
            s.db.execute("DELETE FROM messages WHERE id = %s", (mid,))
        else:
            s.db.execute("UPDATE messages SET body = %s, edited_at = now() WHERE id = %s", (edited, mid))
        changed_at = time.perf_counter()
        for variant in row:
            ids, _ = s.search(variant, agent, check["query"], k=50)
            row[variant]["found_at_once"] = mid in ids
            if variant.startswith("meili"):
                row[variant]["found_at_once_with_recheck"] = mid in recheck(s, agent, ids)
        # The indexing job for Meilisearch, run right after the commit as an outbox would; measure the window it leaves.
        if check["change"] == "edit":
            vector = embed([edited], "passage")[0]
            task = meili("POST", "/indexes/messages/documents", json=[{"id": mid, "body": edited, "_vectors": {"local": vector}}])
        else:
            task = meili("POST", "/indexes/messages/documents/delete-batch", json=[mid])
        seen = row["meili"]["found_at_once"]
        while seen and time.perf_counter() - changed_at < 30:
            seen = found(s, "meili", agent, check["query"], mid)
        leak_ms = round((time.perf_counter() - changed_at) * 1000, 1)
        meili_wait(task)
        for variant in ("meili", "meili_hybrid"):
            row[variant]["found_after_job"] = found(s, variant, agent, check["query"], mid)
            row[variant]["leak_window_ms"] = leak_ms if row[variant]["found_at_once"] else 0
        if check["change"] == "edit":
            # The vector of the new words arrives with the job (here: at once); until then the message is found by keywords only.
            queued = s.db.execute("SELECT count(*) FROM embedding_queue WHERE message_id = %s", (mid,)).fetchone()[0]
            s.db.execute("INSERT INTO message_embeddings (message_id, model, body_hash, embedding) VALUES (%s, %s, 'edited', %s::vector)",
                         (mid, MODEL, vector_literal(embed([edited], "passage")[0])))
            s.db.execute("DELETE FROM embedding_queue WHERE message_id = %s", (mid,))
            new_query = "dostawa przesunięta na poniedziałek"
            row["_edit"] = {"queued_for_embedding": queued, "new_words_found_after_job": {v: found(s, v, agent, new_query, mid) for v in
                                                                                          ("fts_lang", "bm25", "vec", "hybrid_bm25", "meili")}}
        summary_after = s.db.execute("SELECT count(*) FROM conversation_summaries WHERE NOT stale AND source_ids @> ARRAY[%s::uuid]", (mid,)).fetchone()[0]
        row["summaries"] = {"fresh_covering_before": summary_before, "fresh_covering_at_once": summary_after, "ok": summary_before > 0 and summary_after == 0}
        for variant, r in row.items():
            if variant in SEARCHERS:
                r["ok_at_once"] = r["found_before"] and not r["found_at_once"]
        out[check["id"]] = {"what": check["what"], "results": row}
        print("deletion", check["id"], {v: (r.get("found_before"), r.get("found_at_once"), r.get("leak_window_ms")) for v, r in row.items() if v in SEARCHERS},
              "summaries", row["summaries"], row.get("_edit", ""))
    restore(s, data, facts["ovh_password"], next(m["body"] for m in data["messages"] if m["fact"] == "ovh_password"))
    restore(s, data, facts["battery_delivery"], next(m["body"] for m in data["messages"] if m["fact"] == "battery_delivery"))
    results["deletion"] = out


# ---------------------------------------------------------------- tokens

def step_tokens(data, results):
    """Input tokens of the place's messages a run starts with: today's window of 40 versus a search result page (10 hits) and a page
    plus "read around" (the 3 messages before and after each of the top 3 hits). o200k_base counts; other tokenizers differ a little."""
    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")
    s = Searcher(data)
    agent = principal_of(data, "agent", "fieldbot")
    names = {p["id"]: p["name"] for p in data["people"]}
    rows = {str(r[0]): r for r in s.db.execute("SELECT id, conversation_id, sequence, author, created_at, body FROM messages").fetchall()}

    def render(ids):
        return "\n".join(f"[{rows[i][4]:%Y-%m-%d %H:%M}] {names.get(rows[i][3], rows[i][3])}: {rows[i][5]}" for i in ids if i in rows)

    def around(ids, n=3):
        out = []
        for i in ids[:3]:
            conv, seq = rows[i][1], rows[i][2]
            out += [str(r[0]) for r in s.db.execute("SELECT id FROM messages WHERE conversation_id = %s AND sequence BETWEEN %s AND %s ORDER BY sequence",
                                                    (conv, seq - n, seq + n)).fetchall()]
        return list(dict.fromkeys(out + ids))

    totals = {"window40": [], "page10": [], "page10_around": []}
    for q in data["questions"]:
        totals["window40"].append(len(enc.encode(render(s.window(q["asked_in"])))))
        ids, _ = s.search("hybrid_bm25", agent, q["question"], after=q.get("after"), before=q.get("before"))
        totals["page10"].append(len(enc.encode(render(ids))))
        totals["page10_around"].append(len(enc.encode(render(around(ids)))))
    results["tokens"] = {k: {"mean": round(statistics.mean(v)), "p95": round(pct(v, 95))} for k, v in totals.items()}
    avg = statistics.mean(len(enc.encode(m["body"])) for m in data["messages"])
    results["tokens"]["per_message_body_mean"] = round(avg, 1)
    print("tokens", results["tokens"])


STEPS = {"load": step_load, "index": step_index, "recall": step_recall, "write": step_write, "access": step_access,
         "tokens": step_tokens, "deletion": step_deletion}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("steps", nargs="+", help="all, or any of: " + ", ".join(STEPS))
    parser.add_argument("--out", default=str(HERE / "out" / "results.json"))
    args = parser.parse_args()
    steps = list(STEPS) if args.steps == ["all"] else args.steps
    data = seed()
    path = Path(args.out)
    results = json.loads(path.read_text()) if path.exists() and "load" not in steps else {}
    results.setdefault("model", MODEL)
    for name in steps:
        STEPS[name](data, results)
        path.write_text(json.dumps(results, indent=1, ensure_ascii=False, default=str))
    print("results", path)


if __name__ == "__main__":
    sys.exit(main())
