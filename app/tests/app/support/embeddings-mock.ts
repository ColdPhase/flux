import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// TEST ONLY (#1294): a stand-in for the text-embeddings-inference container, speaking its two calls (`GET /info`, `POST /embed`) with
// 1,024-number unit vectors that are made from the words, so a test knows which texts are near each other. Words of one CONCEPT share
// a dimension (a kitten and a kot are the same thing); every other word lands on a dimension of its own with a small weight. It is not
// a model and proves nothing about recall; search-vectors-live.test.ts runs the real container.

export const DIMENSIONS = 1024;
const CONCEPTS = [
  ['cat', 'kitten', 'kot', 'kotek', 'kocur', 'kotka'],
  ['invoice', 'faktura', 'faktury', 'payment', 'zaplata'],
  ['weather', 'pogoda', 'rain', 'deszcz', 'storm', 'burza'],
  ['dog', 'pies', 'szczeniak', 'puppy'],
];
const CONCEPT_OF = new Map(CONCEPTS.flatMap((words, index) => words.map((word) => [word, index] as const)));

const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');

export function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of fold(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    const concept = CONCEPT_OF.get(word);
    if (concept !== undefined) { vector[concept]! += 1; continue; }
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    vector[16 + (hash % 1000)]! += 0.15;
  }
  const length = Math.hypot(...vector);
  if (!length) { vector[DIMENSIONS - 1] = 1; return vector; }
  return vector.map((n) => n / length);
}

export interface EmbeddingsMock {
  url: string;
  /** Every request the server got: path, headers and the texts of an /embed. */
  requests: { path: string; headers: IncomingMessage['headers']; inputs: string[] }[];
  /** While true the server answers 503, as a container that is still loading its model does. */
  down: boolean;
  /** Texts for which /embed answers 413 (a text the server refuses). */
  refuse: Set<string>;
  /** The model it names in /info. */
  model: string;
  stop(): Promise<void>;
}

export async function startEmbeddingsMock(): Promise<EmbeddingsMock> {
  const requests: EmbeddingsMock['requests'] = [];
  const mock: EmbeddingsMock = { url: '', requests, down: false, refuse: new Set(), model: 'fake/bge-m3', async stop() { await new Promise((resolve) => server.close(resolve)); } };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as { inputs?: string[] } : {};
    const path = request.url ?? '';
    requests.push({ path, headers: request.headers, inputs: body.inputs ?? [] });
    const reply = (status: number, payload: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (mock.down) return reply(503, { error: 'model is loading' });
    if (path === '/info' && request.method === 'GET') return reply(200, { model_id: mock.model });
    if (path === '/embed' && request.method === 'POST') {
      const inputs = body.inputs ?? [];
      if (inputs.some((text) => mock.refuse.has(text))) return reply(413, { error: 'input too large' });
      return reply(200, inputs.map(fakeVector));
    }
    return reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
