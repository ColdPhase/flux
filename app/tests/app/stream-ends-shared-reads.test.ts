import assert from 'node:assert/strict';
import { afterEach, before, mock, test } from 'node:test';
import type { StreamEvent } from '@flux/contracts';

// #1023 (N1): reads of the project shell in flight together are one request, but never past a change. A write of this tab ends the sharing
// (api-client-coalescing.test.ts); so does an event of the live stream, which is another tab's write or another person's change, so the
// re-read that the event causes (a project renamed, a grant revoked) never joins a read that began before it.
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: URL) { FakeSocket.all.push(this); }
  close() { /* the test drops nothing */ }
  event(id: string) {
    const event: StreamEvent = { type: 'event', cursor: `cursor-${id}`, id, kind: 'project.renamed.v1', workspaceId: 'w', objectType: 'project', objectId: 'p', createdAt: '2026-11-08T00:00:00Z' };
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
const window = Object.assign(new EventTarget(), {
  location: { href: 'http://flux.test/' },
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
});
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const originals = new Map(['window', 'document', 'WebSocket'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
process.on('exit', () => {
  for (const [name, original] of originals) {
    if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
  }
});

let stream: typeof import('../../apps/web/src/api/stream.js');
let client: typeof import('../../apps/web/src/api/client.js');
before(async () => {
  stream = await import('../../apps/web/src/api/stream.js');
  client = await import('../../apps/web/src/api/client.js');
});
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  stream.resetStream();
  FakeSocket.all = [];
});
// A read starts in a task of its own (a MessageChannel message), which a loaded machine can deliver a few milliseconds late.
const settle = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 60));

function fetchStub(context: { mock: { method: typeof mock.method } }) {
  const calls: { path: string; finish: (body: unknown) => void }[] = [];
  context.mock.method(globalThis, 'fetch', (input: string | URL | Request) => new Promise<Response>((resolve) => {
    calls.push({ path: String(input), finish: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) });
  }));
  return calls;
}

test('an event of the stream ends the sharing: the re-read it causes is a request of its own', async (context) => {
  const calls = fetchStub(context);
  stops.push(stream.subscribe('person-a', { onEvent: () => undefined }));
  const before = client.request<{ name: string }>('/api/v1/projects/p', { share: true });
  await settle();
  assert.equal(calls.length, 1);
  // Another tab renamed the project; the event arrives while the read that began before it is still on its way.
  FakeSocket.all.at(-1)!.event('e1');
  const after = client.request<{ name: string }>('/api/v1/projects/p', { share: true });
  await settle();
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/projects/p', '/api/v1/projects/p'], 'the re-read did not join the older read');
  calls[0]!.finish({ name: 'Old name' });
  calls[1]!.finish({ name: 'New name' });
  assert.deepEqual(await before, { name: 'Old name' }, 'the callers already waiting keep their answer');
  assert.deepEqual(await after, { name: 'New name' });
});

test('without an event the same two reads are still one request', async (context) => {
  const calls = fetchStub(context);
  stops.push(stream.subscribe('person-a', { onEvent: () => undefined }));
  const first = client.request('/api/v1/projects/p', { share: true });
  const second = client.request('/api/v1/projects/p', { share: true });
  await settle();
  assert.equal(calls.length, 1);
  calls[0]!.finish({ name: 'Name' });
  await Promise.all([first, second]);
});
