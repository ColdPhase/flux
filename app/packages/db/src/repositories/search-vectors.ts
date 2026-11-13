import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../handles.js';

/**
 * Vectors of searchable rows (migration 0068, F-042, #1294): the worker's queue and store, and the vector half of hybrid ranking.
 * Off unless `turnOn` wrote the one `search_vector_state` row; without it the triggers of migration 0068 do nothing, so an
 * installation that never turns embeddings on never writes a row here.
 */

/** The channel the migration's triggers NOTIFY when a row is queued; the worker wakes on it and polls nothing. */
export const SEARCH_VECTORS_CHANNEL = 'flux_search_vectors';

/**
 * What each list of a hybrid search contributes at most: the best visible rows by BM25 and by distance. 50, as in the research's bench:
 * with 100 the rows that are only mid-list in both lists crowd out a hit that is first in one (recall@10 0.667 against 0.700 on the
 * bench, #1294).
 */
export const HYBRID_DEPTH = 50;
/** Reciprocal rank fusion's constant (Cormack, Clarke and Büttcher, SIGIR 2009). */
export const RRF_K = 60;

/** The vector of a search's words, or null to rank by BM25 alone (embeddings are off, the server is down or is slow). */
export type QueryVectors = (text: string) => Promise<number[] | null>;

/** A vector as pgvector reads it. */
export const vectorLiteral = (vector: number[]) => `[${vector.join(',')}]`;

/**
 * The end of the ranked statement with a query vector (`rankedStatement` in search.ts, which defines `ranked`: the visible BM25 hits and
 * their rank): `matched`, the fusion by reciprocal rank (k = 60) of two lists of at most {@link HYBRID_DEPTH} rows. `lexical` is the best
 * of `ranked`; `nearest` the rows with the smallest cosine distance to the query's vector **among the rows the caller may see under the
 * same filters** (`visible`: the audiences, the place, the author, the dates, the task lifecycle), each distance computed exactly. No
 * approximate index is used (#1326's rule, F-042: no row the caller may not read may influence what they see): an HNSW scan walks a graph
 * built over every row of the instance and filters afterwards, so which visible rows it returns could depend on hidden ones. The cost is
 * one distance per visible vector (about 2.3 ms per 1,000 on the review's host, #1341).
 *
 * The score is the fused sum scaled to (0, 1] (a row first in both lists is 1, first in one 0.5), like the squashed BM25 rank, so
 * an encrypted space's rows still merge with it; the task the query names by its number keeps its added 10.
 */
export function hybridMatched(parts: { vector: string; visible: SQL; number: number | null }): SQL {
  const depth = sql.raw(String(HYBRID_DEPTH));
  const k = sql.raw(String(RRF_K));
  const scale = sql.raw(String((RRF_K + 1) / 2));
  const numbered = parts.number === null ? sql`false` : sql`(sd.kind = 'work' AND split_part(sd.body, E'\n', 1) = ${`#${parts.number}`})`;
  return sql`lexical AS MATERIALIZED (
      SELECT l.id, row_number() OVER (ORDER BY l.numbered DESC, l.rank DESC, l.at DESC, l.id DESC) AS rk FROM (
        SELECT r.id, r.numbered, r.rank, r.at FROM ranked r ORDER BY r.numbered DESC, r.rank DESC, r.at DESC, r.id DESC LIMIT ${depth}) l
    ),
    distances AS MATERIALIZED (
      SELECT sd.id, v.embedding <=> ${parts.vector}::halfvec AS distance FROM search_documents sd
      JOIN search_vectors v ON v.document_id = sd.id WHERE ${parts.visible}
    ),
    nearest AS MATERIALIZED (
      SELECT n.id, row_number() OVER (ORDER BY n.distance, n.id) AS rk FROM (
        SELECT d.id, d.distance FROM distances d ORDER BY d.distance, d.id LIMIT ${depth}) n
    ),
    fused AS (
      SELECT u.id, sum(1.0 / (${k} + u.rk)) AS fused FROM (SELECT id, rk FROM lexical UNION ALL SELECT id, rk FROM nearest) u GROUP BY u.id
    ),
    matched AS (
      SELECT sd.id, sd.kind, sd.object_id, sd.version, sd.at,
        round((f.fused * ${scale})::numeric, 6) + CASE WHEN ${numbered} THEN 10 ELSE 0 END AS score,
        row_number() OVER (PARTITION BY sd.kind, sd.object_id ORDER BY sd.version DESC NULLS LAST) AS newest
      FROM fused f JOIN search_documents sd ON sd.id = f.id
    ),`;
}

export interface QueuedRow { id: string; text: string; hash: string }

/** The row's words as hashed when claimed; a row edited since no longer matches, and its old vector is not stored. */
const WORDS_HASH = sql`md5(d.title || chr(1) || d.body)`;
const ELIGIBLE = sql`search_vector_eligible(d.kind, d.sealed, d.title, d.body, d.project_id)`;
const ADVISORY_LOCK = 'flux-search-vectors';

export function searchVectorRows(db: Database) {
  return {
    /**
     * Switches embeddings on for `model`: writes the state row, and queues every eligible row that has no vector. Another model
     * than the one that made the stored vectors drops them all first (vectors of two models are no neighbours of each other).
     */
    async turnOn(model: string): Promise<{ reset: boolean; queued: number }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK}))`);
        const state = (await tx.execute(sql`SELECT model FROM search_vector_state`)).rows[0] as { model: string } | undefined;
        const reset = !!state && state.model !== model;
        if (reset) await tx.execute(sql`TRUNCATE search_vectors, search_vector_queue`);
        if (!state) await tx.execute(sql`INSERT INTO search_vector_state (model) VALUES (${model})`);
        else if (reset) await tx.execute(sql`UPDATE search_vector_state SET model = ${model}, started_at = now()`);
        const queued = await tx.execute(sql`INSERT INTO search_vector_queue (document_id)
          SELECT d.id FROM search_documents d
          WHERE ${ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM search_vectors v WHERE v.document_id = d.id)
          ON CONFLICT DO NOTHING`);
        return { reset, queued: queued.rowCount ?? 0 };
      });
    },

    /** Switches embeddings off: the state row, every vector and the queue go. Costs one statement when they were never on. */
    async turnOff(): Promise<boolean> {
      return db.transaction(async (tx) => {
        const gone = await tx.execute(sql`DELETE FROM search_vector_state`);
        if (!gone.rowCount) return false;
        await tx.execute(sql`TRUNCATE search_vectors, search_vector_queue`);
        return true;
      });
    },

    async claim(limit: number, maxChars: number): Promise<QueuedRow[]> {
      return db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`WITH q AS MATERIALIZED (
            SELECT document_id FROM search_vector_queue ORDER BY queued_at, document_id LIMIT ${limit})
          SELECT d.id::text AS id, ${ELIGIBLE} AS eligible,
            left(CASE WHEN d.title <> '' THEN d.title || E'\n' || d.body ELSE d.body END, ${maxChars}) AS text, ${WORDS_HASH} AS hash
          FROM q JOIN search_documents d ON d.id = q.document_id`)).rows as { id: string; eligible: boolean; text: string; hash: string }[];
        const gone = rows.filter((row) => !row.eligible).map((row) => row.id);
        if (gone.length) await tx.execute(sql`DELETE FROM search_vector_queue WHERE document_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${JSON.stringify(gone)}::jsonb))`);
        return rows.filter((row) => row.eligible).map(({ id, text, hash }) => ({ id, text, hash }));
      });
    },

    /**
     * Writes vectors for rows that have not changed since they were claimed and may still be embedded. The rows and their spaces'
     * AI policies are locked first (share), so an edit or a turned-off AI that is committing waits for this write or is seen by
     * it: a vector of old words, or of a space whose AI is off, is never left behind.
     */
    async store(vectors: { id: string; hash: string; vector: number[] }[]): Promise<number> {
      if (!vectors.length) return 0;
      const ids = JSON.stringify(vectors.map((item) => item.id));
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT a.project_id FROM project_ai_policies a WHERE a.project_id IN (
            SELECT d.project_id FROM search_documents d WHERE d.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${ids}::jsonb)))
          ORDER BY a.project_id FOR SHARE`);
        const current = (await tx.execute(sql`SELECT d.id::text AS id, ${WORDS_HASH} AS hash FROM search_documents d
          WHERE d.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${ids}::jsonb)) AND ${ELIGIBLE}
          ORDER BY d.id FOR SHARE OF d`)).rows as { id: string; hash: string }[];
        const hashes = new Map(current.map((row) => [row.id, row.hash]));
        const fresh = vectors.filter((item) => hashes.get(item.id) === item.hash);
        if (!fresh.length) return 0;
        const payload = JSON.stringify(fresh.map((item) => ({ id: item.id, vector: vectorLiteral(item.vector) })));
        const written = await tx.execute(sql`INSERT INTO search_vectors (document_id, embedding)
          SELECT (e->>'id')::bigint, (e->>'vector')::halfvec FROM jsonb_array_elements(${payload}::jsonb) e
          WHERE EXISTS (SELECT 1 FROM search_vector_state)
          ON CONFLICT (document_id) DO UPDATE SET embedding = EXCLUDED.embedding
          RETURNING document_id`);
        const done = JSON.stringify(written.rows.map((row) => String((row as { document_id: string | number }).document_id)));
        await tx.execute(sql`DELETE FROM search_vector_queue WHERE document_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${done}::jsonb))`);
        return written.rowCount ?? 0;
      });
    },

    async drop(ids: string[]): Promise<void> {
      if (!ids.length) return;
      await db.execute(sql`DELETE FROM search_vector_queue WHERE document_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
    },

    /** Test and operator support: rows waiting, and rows with a vector. */
    async counts(): Promise<{ queued: number; vectors: number; model: string | null }> {
      const row = (await db.execute(sql`SELECT (SELECT count(*) FROM search_vector_queue)::int AS queued,
        (SELECT count(*) FROM search_vectors)::int AS vectors, (SELECT model FROM search_vector_state) AS model`)).rows[0] as { queued: number; vectors: number; model: string | null };
      return row;
    },
  };
}
