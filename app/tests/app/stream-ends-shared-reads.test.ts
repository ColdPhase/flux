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
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
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

test('an event that is held for a hidden page ends the sharing when it arrives, not when it is delivered', async (context) => {
  const calls = fetchStub(context);
  const delivered: string[] = [];
  stops.push(stream.subscribe('person-a', { onEvent: (event) => { delivered.push(event.id); } }));
  document.visibilityState = 'hidden';
  try {
    const before = client.request('/api/v1/projects/p', { share: true });
    await settle();
    assert.equal(calls.length, 1);
    FakeSocket.all.at(-1)!.event('e-held');
    assert.deepEqual(delivered, [], 'the event is held while the page is hidden');
    const after = client.request('/api/v1/projects/p', { share: true });
    await settle();
    assert.equal(calls.length, 2, 'the read asked for after the event did not join the older one');
    calls[0]!.finish({ name: 'Old name' });
    calls[1]!.finish({ name: 'New name' });
    await Promise.all([before, after]);
  } finally {
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  }
  assert.deepEqual(delivered, ['e-held'], 'and it is delivered once the page is visible');
});

test('a resync ends the sharing: events may have been missed, so a read on its way may not show the change', async (context) => {
  const calls = fetchStub(context);
  let resyncs = 0;
  stops.push(stream.subscribe('person-a', { onEvent: () => undefined, onResync: () => { resyncs += 1; } }));
  // An event gives the stream a cursor; the connection then drops before it ever opened twice in a row, so the cursor is refused and the
  // stream starts again from the head and asks for a refetch when that connection opens.
  FakeSocket.all.at(-1)!.event('e1');
  FakeSocket.all.at(-1)!.onclose?.({ code: 1006 });
  window.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.all.length, 2, 'it reconnected with the cursor');
  FakeSocket.all.at(-1)!.onclose?.({ code: 1006 });
  await settle();
  assert.equal(FakeSocket.all.length, 3, 'and then from the head');
  const before = client.request('/api/v1/projects/p', { share: true });
  await settle();
  assert.equal(calls.length, 1);
  FakeSocket.all.at(-1)!.onopen?.();
  assert.equal(resyncs, 1, 'listeners were asked to refetch');
  const after = client.request('/api/v1/projects/p', { share: true });
  await settle();
  assert.equal(calls.length, 2, 'the refetch did not join the read that began before the resync');
  calls[0]!.finish({ name: 'Old name' });
  calls[1]!.finish({ name: 'New name' });
  await Promise.all([before, after]);
});
