import { createEmbedder, EMBED_BATCH, EMBED_TEXT_LIMIT, EmbeddingsError, embedQueued, loadEmbeddingsConfig, type EmbeddingStore, type TextEmbedder } from '@flux/core';
import { listen, SEARCH_VECTORS_CHANNEL, searchVectorRows, type Database } from '@flux/db';

// Optional local embeddings (F-042, #1294). With FLUX_EMBEDDINGS_URL empty this switches them off once (one statement, and it empties
// the vector tables if they were on) and runs nothing. With it set, the worker wakes on the NOTIFY that the triggers of migration 0068
// send when a row is queued, embeds the queue through the operator's own container and stores the vectors: no timer runs while the
// queue is empty, so an idle worker issues no statement for this. A timer exists only after a failure (the container is still loading
// its model, or is down) and doubles from 2 s to 60 s.

type Log = (message: string, details?: Record<string, unknown>) => void;
const RETRY_FIRST_MS = 2_000;
const RETRY_LAST_MS = 60_000;

export interface SearchVectorsOptions {
  db: Database;
  connectionString: string;
  env?: NodeJS.ProcessEnv;
  /** Test support: the embedder and the store in place of the container's client and the database's rows. */
  embedder?: TextEmbedder;
  store?: EmbeddingStore;
  log?: Log;
}

export async function startSearchVectors(options: SearchVectorsOptions) {
  const { db, connectionString, env = process.env, log = (message, details) => console.warn(message, details ?? {}) } = options;
  const config = loadEmbeddingsConfig(env);
  const rows = searchVectorRows(db);
  if (config.status === 'off') {
    if (await rows.turnOff()) log('Embeddings are off: the vectors were removed');
    return { async tick() { /* off */ }, async stop() { /* off */ } };
  }
  const embedder = options.embedder ?? createEmbedder(config.url);
  const store: EmbeddingStore = options.store ?? { claim: (limit) => rows.claim(limit, EMBED_TEXT_LIMIT), store: (vectors) => rows.store(vectors), drop: (ids) => rows.drop(ids) };
  let ready = false;
  let running = false;
  let again = false;
  let stopped = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  // The model must answer and be bge-m3-sized before the state row switches the triggers on; a model that changed since the last
  // start drops the old model's vectors (turnOn).
  const prepare = async () => {
    const model = await embedder.model();
    await embedder.embed(['probe']);
    const { reset, queued } = await rows.turnOn(model);
    if (reset) log('The embedding model changed: the stored vectors were dropped and every row is queued again', { model });
    log('Embeddings are on', { model, queued });
    ready = true;
  };

  const tick = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        if (!ready) await prepare();
        // Until the queue is empty; a pass that stored nothing (rows edited while embedded, to be claimed again) does not spin.
        for (;;) {
          const pass = await embedQueued(store, embedder, EMBED_BATCH);
          if (stopped || !pass.claimed) break;
          if (pass.stored) console.log(JSON.stringify({ job: 'search.vectors', stored: pass.stored, dropped: pass.dropped }));
          if (!pass.stored && !pass.dropped) break;
        }
        failures = 0;
      } while (again && !stopped);
    } catch (error) {
      failures += 1;
      const wait = Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
      const kind = error instanceof EmbeddingsError ? error.kind : 'error';
      // The container's first start downloads its model (minutes): that is not worth a line a try.
      if (failures === 1 || failures % 10 === 0 || kind === 'incompatible') log('Embedding failed; trying again later', { kind, error: (error as Error).message, retryInSeconds: wait / 1000 });
      clearTimeout(retry);
      retry = setTimeout(() => void tick(), wait).unref();
    } finally {
      running = false;
    }
  };

  const listener = listen(connectionString, SEARCH_VECTORS_CHANNEL, () => void tick(), () => void tick(), (error) => log('Embedding listener interrupted', { error: error.message }));
  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(retry);
      await listener.close();
    },
  };
}
