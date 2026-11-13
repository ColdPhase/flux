// Optional local embeddings (F-042, #1294): a vector per searchable row, for hybrid ranking next to BM25. Off unless the operator
// runs the embedding container (docker/compose.embeddings.yaml) and sets FLUX_EMBEDDINGS_URL. The server is text-embeddings-inference
// with bge-m3: 1,024 numbers per text, cosine distance. Nothing here uses a person's connection or key: the only network call is
// to the operator's own container.

/** Numbers per vector: bge-m3's. The database column is `vector(1024)`. */
export const EMBEDDING_DIMENSIONS = 1024;
/** Texts per request to the server. */
export const EMBED_BATCH = 16;
/** The characters of a row that are embedded (its title and the start of its body): a longer text costs the CPU, not the meaning. */
export const EMBED_TEXT_LIMIT = 4000;
/** How long a person's search waits for its query's vector before it ranks by BM25 alone. */
export const QUERY_EMBED_TIMEOUT_MS = 1500;
/** After a failed query embedding, searches rank by BM25 alone for this long instead of each waiting for the server. */
export const QUERY_EMBED_COOLDOWN_MS = 30_000;

export type EmbeddingsConfig = { status: 'off' } | { status: 'on'; url: string };

/** `FLUX_EMBEDDINGS_URL`, the embedding container's address (`http://embeddings:80` in the overlay). Empty is off. */
export function loadEmbeddingsConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig {
  const value = env.FLUX_EMBEDDINGS_URL?.trim();
  if (!value) return { status: 'off' };
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('FLUX_EMBEDDINGS_URL must be the address of the embedding container, for example http://embeddings:80'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('FLUX_EMBEDDINGS_URL must be an http(s) address');
  return { status: 'on', url: url.origin + url.pathname.replace(/\/$/, '') };
}

/**
 * Why an embedding call failed. `unavailable`: the server is down, loading its model or overloaded (try again later).
 * `rejected`: the server refused this text (a 4xx; the text is skipped). `incompatible`: it answered with something that cannot
 * be used, such as vectors of another size (a wrong model: nothing is stored and nothing is dropped).
 */
export class EmbeddingsError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'rejected' | 'incompatible') {
    super(message);
    this.name = 'EmbeddingsError';
  }
}

export interface TextEmbedder {
  /** One unit vector of {@link EMBEDDING_DIMENSIONS} numbers per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** The model the server runs (its `model_id`). */
  model(): Promise<string>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The client of a text-embeddings-inference server: `POST /embed` (normalised, truncated to the model's window) and `GET /info`. */
export function createEmbedder(baseUrl: string, options: { fetch?: Fetch; timeoutMs?: number } = {}): TextEmbedder {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await call(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new EmbeddingsError(`The embedding server did not answer: ${(error as Error).message}`, 'unavailable');
    }
    if (!response.ok) {
      const kind = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'rejected' : 'unavailable';
      throw new EmbeddingsError(`The embedding server answered ${response.status}`, kind);
    }
    try { return await response.json(); } catch { throw new EmbeddingsError('The embedding server answered something that is not JSON', 'incompatible'); }
  };
  return {
    async embed(texts) {
      if (!texts.length) return [];
      const body = await request('/embed', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: texts.map((text) => text.slice(0, EMBED_TEXT_LIMIT)), normalize: true, truncate: true }),
      });
      if (!Array.isArray(body) || body.length !== texts.length
        || body.some((vector) => !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || vector.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) {
        throw new EmbeddingsError(`The embedding server must answer ${EMBEDDING_DIMENSIONS}-number vectors (bge-m3); this answer is another model's`, 'incompatible');
      }
      return body as number[][];
    },
    async model() {
      const info = await request('/info', { method: 'GET' }) as { model_id?: unknown };
      if (typeof info?.model_id !== 'string' || !info.model_id) throw new EmbeddingsError('The embedding server did not name its model', 'incompatible');
      return info.model_id;
    },
  };
}

/**
 * The vector of a search's words, or null when the search should rank by BM25 alone: a short deadline, and after a failure a
 * cool-down in which no search waits for the server at all. A search never fails because embeddings are down.
 */
export function createQueryVectors(embedder: TextEmbedder, options: { cooldownMs?: number; now?: () => number; log?: (message: string) => void } = {}) {
  const cooldownMs = options.cooldownMs ?? QUERY_EMBED_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message) => console.warn(message));
  let skipUntil = 0;
  return async (text: string): Promise<number[] | null> => {
    if (now() < skipUntil || !text.trim()) return null;
    try {
      const [vector] = await embedder.embed([text]);
      return vector ?? null;
    } catch (error) {
      skipUntil = now() + cooldownMs;
      log(`Search ranks by BM25 alone for ${Math.round(cooldownMs / 1000)} s: ${(error as Error).message}`);
      return null;
    }
  };
}

/** A row waiting for its vector, as the store hands it out: the text to embed and a hash of the row's words as they are now. */
export interface EmbeddingJob { id: string; text: string; hash: string }

export interface EmbeddingStore {
  /** Up to `limit` queued rows that may be embedded now, oldest first; rows that no longer may be are taken off the queue. */
  claim(limit: number): Promise<EmbeddingJob[]>;
  /** Writes the vectors of rows whose words still hash the same and that may still be embedded; returns how many were written. */
  store(vectors: { id: string; hash: string; vector: number[] }[]): Promise<number>;
  /** Takes rows the server refused off the queue. */
  drop(ids: string[]): Promise<void>;
}

export interface EmbedPass { claimed: number; stored: number; dropped: number }

/**
 * One pass over the queue: claim a batch, embed it, store it. A text the server refuses (a 4xx) is skipped, alone, so one bad row
 * never holds up the rest; an unavailable or incompatible server throws and the queue stays as it is.
 */
export async function embedQueued(store: EmbeddingStore, embedder: TextEmbedder, limit = EMBED_BATCH): Promise<EmbedPass> {
  const jobs = await store.claim(limit);
  if (!jobs.length) return { claimed: 0, stored: 0, dropped: 0 };
  const vectors: { id: string; hash: string; vector: number[] }[] = [];
  const refused: string[] = [];
  try {
    const embedded = await embedder.embed(jobs.map((job) => job.text));
    jobs.forEach((job, index) => vectors.push({ id: job.id, hash: job.hash, vector: embedded[index]! }));
  } catch (error) {
    if (!(error instanceof EmbeddingsError) || error.kind !== 'rejected') throw error;
    for (const job of jobs) {
      try { vectors.push({ id: job.id, hash: job.hash, vector: (await embedder.embed([job.text]))[0]! }); }
      catch (single) {
        if (!(single instanceof EmbeddingsError) || single.kind !== 'rejected') throw single;
        refused.push(job.id);
      }
    }
  }
  if (refused.length) await store.drop(refused);
  const stored = vectors.length ? await store.store(vectors) : 0;
  return { claimed: jobs.length, stored, dropped: refused.length };
}
