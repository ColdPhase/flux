import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createEmbedder, createQueryVectors, EMBEDDING_DIMENSIONS, EmbeddingsError, embedQueued, loadEmbeddingsConfig, type EmbeddingJob, type EmbeddingStore, type TextEmbedder } from '@flux/core';

// The pure side of the optional embeddings (F-042, #1294): the setting, the client of the container, the query hook that never
// fails a search, and one pass over the queue, over a store and an embedder that are not the database and the container.

const unit = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FLUX_EMBEDDINGS_URL', () => {
  test('empty is off; an http(s) address is on, without a trailing slash; anything else stops the process with a message', () => {
    assert.deepEqual(loadEmbeddingsConfig({}), { status: 'off' });
    assert.deepEqual(loadEmbeddingsConfig({ FLUX_EMBEDDINGS_URL: '  ' }), { status: 'off' });
    assert.deepEqual(loadEmbeddingsConfig({ FLUX_EMBEDDINGS_URL: 'http://embeddings:8080/' }), { status: 'on', url: 'http://embeddings:8080' });
    assert.throws(() => loadEmbeddingsConfig({ FLUX_EMBEDDINGS_URL: 'embeddings:8080' }), /FLUX_EMBEDDINGS_URL/);
    assert.throws(() => loadEmbeddingsConfig({ FLUX_EMBEDDINGS_URL: 'file:///etc/passwd' }), /http\(s\)/);
  });
});

describe('the container client', () => {
  test('asks /embed for normalised, truncated vectors of the texts only, and checks what comes back', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const embedder = createEmbedder('http://embeddings:8080', { fetch: async (url, init) => { seen.push({ url, init: init as RequestInit }); return reply(200, [unit(), unit()]); } });
    assert.equal((await embedder.embed(['a', 'b'])).length, 2);
    assert.equal(seen[0]!.url, 'http://embeddings:8080/embed');
    assert.deepEqual(JSON.parse(String(seen[0]!.init!.body)), { inputs: ['a', 'b'], normalize: true, truncate: true });
    assert.equal((seen[0]!.init!.headers as Record<string, string>).authorization, undefined, 'no key goes with it');
  });

  test('tells an unavailable container, a refused text and another model apart', async () => {
    const kind = async (respond: () => Response | Promise<Response>) => {
      try { await createEmbedder('http://x', { fetch: async () => respond() }).embed(['a']); return 'ok'; } catch (error) { return (error as EmbeddingsError).kind; }
    };
    assert.equal(await kind(() => reply(503, {})), 'unavailable');
    assert.equal(await kind(() => reply(429, {})), 'unavailable');
    assert.equal(await kind(() => { throw new Error('ECONNREFUSED'); }), 'unavailable');
    assert.equal(await kind(() => reply(413, {})), 'rejected');
    assert.equal(await kind(() => reply(422, {})), 'rejected');
    assert.equal(await kind(() => reply(200, [[1, 2, 3]])), 'incompatible', 'vectors of another size');
    assert.equal(await kind(() => reply(200, [])), 'incompatible', 'a vector missing');
    assert.equal(await kind(() => new Response('not json', { status: 200 })), 'incompatible');
  });

  test('the model is the one /info names', async () => {
    assert.equal(await createEmbedder('http://x', { fetch: async () => reply(200, { model_id: 'BAAI/bge-m3' }) }).model(), 'BAAI/bge-m3');
    await assert.rejects(createEmbedder('http://x', { fetch: async () => reply(200, {}) }).model(), /name its model/);
  });
});

describe('the query hook', () => {
  test('gives the vector, and after a failure answers null without asking again until the cool-down is over', async () => {
    let calls = 0;
    let down = true;
    let clock = 0;
    const embedder: TextEmbedder = { model: async () => 'm', embed: async () => { calls += 1; if (down) throw new EmbeddingsError('down', 'unavailable'); return [unit()]; } };
    const logged: string[] = [];
    const hook = createQueryVectors(embedder, { cooldownMs: 30_000, now: () => clock, log: (message) => logged.push(message) });
    assert.equal(await hook('cat'), null);
    assert.equal(await hook('cat'), null);
    assert.equal(calls, 1, 'the second search did not wait for the container');
    assert.equal(logged.length, 1);
    down = false;
    clock = 31_000;
    assert.equal((await hook('cat'))!.length, EMBEDDING_DIMENSIONS);
    assert.equal(await hook('   '), null, 'no words, no vector');
  });
});

describe('one pass over the queue', () => {
  const jobs = (...texts: string[]): EmbeddingJob[] => texts.map((text, i) => ({ id: String(i + 1), text, hash: `h${i + 1}` }));
  function fakeStore(queue: EmbeddingJob[]) {
    const stored: string[] = [];
    const dropped: string[] = [];
    const store: EmbeddingStore = {
      claim: async (limit) => queue.slice(0, limit),
      store: async (vectors) => { stored.push(...vectors.map((v) => `${v.id}:${v.hash}`)); return vectors.length; },
      drop: async (ids) => { dropped.push(...ids); },
    };
    return { store, stored, dropped };
  }

  test('embeds a batch and stores each vector with the hash of the words it was made from', async () => {
    const { store, stored } = fakeStore(jobs('one', 'two'));
    const pass = await embedQueued(store, { model: async () => 'm', embed: async (texts) => texts.map(unit) });
    assert.deepEqual(pass, { claimed: 2, stored: 2, dropped: 0 });
    assert.deepEqual(stored, ['1:h1', '2:h2']);
  });

  test('an empty queue is one claim and nothing else', async () => {
    let embedded = 0;
    const { store } = fakeStore([]);
    assert.deepEqual(await embedQueued(store, { model: async () => 'm', embed: async () => { embedded += 1; return []; } }), { claimed: 0, stored: 0, dropped: 0 });
    assert.equal(embedded, 0);
  });

  test('a refused text is skipped alone and taken off the queue; the others are stored', async () => {
    const { store, stored, dropped } = fakeStore(jobs('fine', 'too big', 'also fine'));
    const embedder: TextEmbedder = { model: async () => 'm', embed: async (texts) => {
      if (texts.includes('too big')) throw new EmbeddingsError('413', 'rejected');
      return texts.map(unit);
    } };
    assert.deepEqual(await embedQueued(store, embedder), { claimed: 3, stored: 2, dropped: 1 });
    assert.deepEqual(stored, ['1:h1', '3:h3']);
    assert.deepEqual(dropped, ['2']);
  });

  test('an unavailable or incompatible container leaves the queue as it is', async () => {
    for (const kind of ['unavailable', 'incompatible'] as const) {
      const { store, stored, dropped } = fakeStore(jobs('one', 'two'));
      await assert.rejects(embedQueued(store, { model: async () => 'm', embed: async () => { throw new EmbeddingsError(kind, kind); } }), { kind });
      assert.deepEqual([stored, dropped], [[], []]);
    }
  });
});
