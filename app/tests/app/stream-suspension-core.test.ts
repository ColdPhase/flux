import assert from 'node:assert/strict';
import { afterEach, before, mock, test } from 'node:test';
import type { StreamEvent } from '@flux/contracts';

// The web app's event stream while its page is being left or hidden (#471): no listener refetches
// then, events keep their order, and a refetch that is asked for (reconnect from the head, overflow)
// is held as one request until the same document is live again. A fake window, document and
// WebSocket drive the real modules.
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: URL) { FakeSocket.all.push(this); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  event(id: string) {
    const event: StreamEvent = { type: 'event', cursor: `cursor-${id}`, id, kind: 'task.changed.v1', workspaceId: 'w', objectType: 'project', objectId: 'p', createdAt: '2026-10-11T00:00:00Z' };
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(code = 1006) { this.onclose?.({ code }); }
  get cursor() { return this.url.searchParams.get('cursor'); }
}
const socket = () => FakeSocket.all.at(-1)!;

const window = Object.assign(new EventTarget(), {
  location: { href: 'http://flux.test/' },
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
});
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const fire = (name: string) => window.dispatchEvent(new Event(name));
const setVisibility = (state: 'visible' | 'hidden') => { document.visibilityState = state; document.dispatchEvent(new Event('visibilitychange')); };
const tick = (ms: number) => mock.timers.tick(ms);
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
let leaving: typeof import('../../apps/web/src/api/pageLeaving.js');
before(async () => {
  stream = await import('../../apps/web/src/api/stream.js');
  leaving = await import('../../apps/web/src/api/pageLeaving.js');
});
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  stream.resetStream();
  fire('pageshow');
  setVisibility('visible');
  mock.timers.reset();
  FakeSocket.all = [];
});

/** Listens as `owner` and returns what its listener was told, in order. */
function listen(owner = 'person-a') {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  const seen: string[] = [];
  const stop = stream.subscribe(owner, { onEvent: (event) => seen.push(event.id), onResync: () => seen.push('resync') });
  stops.push(stop);
  return { seen, stop };
}

/** The connection with a cursor is refused before it opens: the cursor is dropped and a connection from the head follows. */
function refusedCursorThenHead() {
  const last = socket().cursor;
  socket().drop(1006); // an open connection drops: reconnect with the last cursor
  tick(500);
  assert.notEqual(socket().cursor, null, `resumes from a cursor (was ${last})`);
  socket().drop(1006); // refused while resuming: it never opened
  tick(0);
  assert.equal(socket().cursor, null, 'a connection from the head');
}

test('a live page delivers events at once, once each', () => {
  const { seen } = listen();
  socket().open();
  socket().event('e1');
  socket().event('e1');
  socket().event('e2');
  assert.deepEqual(seen, ['e1', 'e2']);
});

test('while the page is being left events are held and delivered in order once it is live again', () => {
  const ways = {
    'the grace of a cancelled navigation ends': () => tick(leaving.LEAVING_GRACE_MS),
    'a click proves the page stays': () => fire('pointerdown'),
    'the page is shown again': () => { fire('pagehide'); fire('pageshow'); },
  };
  for (const [way, live] of Object.entries(ways)) {
    const { seen, stop } = listen();
    socket().open();
    fire('beforeunload');
    socket().event('e1');
    socket().event('e2');
    assert.deepEqual(seen, [], `${way}: nothing refetches while the page is left`);
    live();
    assert.deepEqual(seen, ['e1', 'e2'], way);
    socket().event('e3');
    assert.deepEqual(seen, ['e1', 'e2', 'e3'], way);
    stop();
    stream.resetStream();
  }
});

test('an unloaded page never delivers what it held', () => {
  const { seen } = listen();
  socket().open();
  fire('beforeunload');
  fire('pagehide');
  socket().event('e1');
  tick(60_000);
  assert.deepEqual(seen, []);
});

test('a hidden tab holds events until it is visible, and a leaving page until that is over too', () => {
  const { seen } = listen();
  socket().open();
  setVisibility('hidden');
  socket().event('e1');
  fire('beforeunload');
  socket().event('e2');
  setVisibility('visible');
  assert.deepEqual(seen, [], 'still being left');
  tick(leaving.LEAVING_GRACE_MS);
  assert.deepEqual(seen, ['e1', 'e2']);
});

test('a visible page never holds events, even when a visibility change was never reported', () => {
  const { seen } = listen();
  socket().open();
  setVisibility('hidden');
  socket().event('e1');
  document.visibilityState = 'visible'; // the browser did not report the change
  socket().event('e2');
  assert.deepEqual(seen, ['e1', 'e2'], 'a visible page delivers at once, what was held first');
  setVisibility('visible');
  assert.deepEqual(seen, ['e1', 'e2'], 'nothing is delivered twice');
});

test('a reconnect from the head that opens while the page is left asks for no refetch until it is live, once', () => {
  const { seen } = listen();
  socket().open();
  socket().event('e1');
  refusedCursorThenHead();
  fire('beforeunload');
  socket().open();
  assert.deepEqual(seen, ['e1'], 'no resync while the page is left');
  tick(leaving.LEAVING_GRACE_MS - 1);
  assert.deepEqual(seen, ['e1']);
  tick(1);
  assert.deepEqual(seen, ['e1', 'resync'], 'the cancelled navigation recovers the refetch');
  tick(60_000);
  assert.deepEqual(seen, ['e1', 'resync'], 'and only once');
});

test('a head reconnect that opens while the tab is hidden resyncs when the tab is visible', () => {
  const { seen } = listen();
  socket().open();
  socket().event('e1');
  refusedCursorThenHead();
  setVisibility('hidden');
  socket().open();
  assert.deepEqual(seen, ['e1']);
  setVisibility('visible');
  assert.deepEqual(seen, ['e1', 'resync']);
});

test('a head reconnect that opens on a page that was then unloaded never refetches', () => {
  const { seen } = listen();
  socket().open();
  socket().event('e1');
  refusedCursorThenHead();
  fire('beforeunload');
  fire('pagehide');
  socket().open();
  tick(60_000);
  assert.deepEqual(seen, ['e1']);
});

test('a refetch asked for several times while paused runs once, and events that came after it are not repeated', () => {
  const { seen } = listen();
  socket().open();
  socket().event('e1');
  setVisibility('hidden');
  refusedCursorThenHead();
  socket().open();
  socket().event('e2');
  refusedCursorThenHead();
  socket().open();
  assert.deepEqual(seen, ['e1']);
  setVisibility('visible');
  assert.deepEqual(seen, ['e1', 'resync']);
});

test('more than 200 held events become one resync, and what is held stays bounded', () => {
  const { seen } = listen();
  socket().open();
  fire('beforeunload');
  for (let index = 0; index < 500; index += 1) socket().event(`e${index}`);
  assert.deepEqual(seen, []);
  fire('pointerdown');
  assert.deepEqual(seen, ['resync']);
  socket().event('later');
  assert.deepEqual(seen, ['resync', 'later'], 'live delivery continues');
});

test('held work belongs to one person: account switching and sign-out forget it', () => {
  const first = listen('person-a');
  socket().open();
  fire('beforeunload');
  socket().event('a1');
  const previous = socket();
  const second: string[] = [];
  stops.push(stream.subscribe('person-b', { onEvent: (event) => second.push(event.id), onResync: () => second.push('resync') }));
  assert.equal(previous.closed, true, 'the previous account stream is closed');
  fire('pointerdown');
  assert.deepEqual(first.seen, [], 'person A is not told after the account changed');
  assert.deepEqual(second, [], 'person B is not given what person A waited for');

  fire('beforeunload');
  socket().open();
  socket().event('b1');
  stream.resetStream(); // sign-out
  fire('pointerdown');
  assert.deepEqual(second, [], 'sign-out drops what was held');
});

test('the last listener leaving drops what was held for it', () => {
  const first = listen();
  socket().open();
  fire('beforeunload');
  socket().event('e1');
  first.stop();
  const later: string[] = [];
  stops.push(stream.subscribe('person-a', { onEvent: (event) => later.push(event.id) }));
  fire('pointerdown');
  assert.deepEqual(later, [], 'a listener that comes later is not given an old event');
});
