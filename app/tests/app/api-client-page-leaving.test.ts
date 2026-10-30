import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

// The web API client starts no request while the page is being left (#471): the browser has stopped the
// page's loads, and WebKit reports a fetch that starts then as an uncaught page error even though the app
// handles the rejection. The request waits and starts when the page is live again; a real failure is still
// an error the caller sees. A fake window and fetch drive the real client and gate.
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { window: globals.window, fetch: globals.fetch, MessageChannel: globals.MessageChannel };
// A read starts in a task of its own, which the client schedules through a MessageChannel (#716). A real port with a
// listener keeps a Node process alive, so a stand-in delivers the same message on the next turn of the event loop.
class TaskChannel {
  port1: { onmessage: (() => void) | null } = { onmessage: null };
  port2 = { postMessage: () => { setImmediate(() => this.port1.onmessage?.()); } };
}
globals.MessageChannel = TaskChannel;
const window = Object.assign(new EventTarget(), {
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
});
globals.window = window;
const { request, ApiError, NetworkError } = await import('../../apps/web/src/api/client.js');
const { LEAVING_GRACE_MS } = await import('../../apps/web/src/api/pageLeaving.js');

const calls: Array<{ path: string; keepalive: boolean | undefined; aborted: boolean }> = [];
let respond: () => Promise<Response> = async () => Response.json({ ok: true });
const fire = (name: string) => window.dispatchEvent(new Event(name));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  calls.length = 0;
  respond = async () => Response.json({ ok: true });
  mock.timers.enable({ apis: ['setTimeout'] });
  globals.fetch = async (path: string, init: RequestInit) => {
    calls.push({ path, keepalive: init.keepalive, aborted: !!init.signal?.aborted });
    return respond();
  };
});
afterEach(() => {
  fire('pageshow'); // every test leaves the page live
  mock.timers.reset();
  globals.fetch = saved.fetch;
});
after(() => { globals.window = saved.window; globals.MessageChannel = saved.MessageChannel; });

test('a live page starts a read in a task of its own and a write at once', async () => {
  const read = request<{ ok: boolean }>('/api/v1/a');
  assert.equal(calls.length, 0, 'a read waits for a task of its own (#716)');
  assert.deepEqual(await read, { ok: true });
  assert.equal(calls.length, 1);
  const write = request('/api/v1/b', { method: 'POST', body: {} });
  assert.equal(calls.length, 2, 'fetch is called before the first await');
  await write;
});

test('a page being left starts no request until a click proves the person is still here', async () => {
  fire('beforeunload');
  const done = request('/api/v1/a');
  await settle();
  assert.equal(calls.length, 0, 'nothing starts while the page is left');
  fire('pointerdown');
  await done;
  assert.equal(calls.length, 1);
});

// #758, #759: the shell's reads (working-agents, needs-you, notification preferences) are asked for by effects and start in the
// task after the one that asked. A navigation that begins in between used to find the gate open, and its read then started
// after `beforeunload`, which WebKit reports as an uncaught page error.
test('a read asked for just before the page begins to leave waits for the page to be live', async () => {
  const done = request('/api/v1/a');
  fire('beforeunload');
  await settle();
  await settle();
  assert.equal(calls.length, 0, 'the navigation began before the read started, so the read does not start');
  fire('pointerdown');
  await done;
  assert.equal(calls.length, 1, 'held back, not dropped');
});

test('reads asked for in one task, then the page is left, all wait and all start once it is live', async () => {
  const all = Promise.all([request('/api/v1/a'), request('/api/v1/b'), request('/api/v1/c')]);
  fire('beforeunload');
  fire('pagehide');
  await settle();
  await settle();
  assert.equal(calls.length, 0);
  fire('pageshow');
  await all;
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/a', '/api/v1/b', '/api/v1/c']);
});

test('the request starts after the grace of a navigation that was cancelled', async () => {
  fire('beforeunload');
  const done = request('/api/v1/a');
  mock.timers.tick(LEAVING_GRACE_MS - 1);
  await settle();
  assert.equal(calls.length, 0);
  mock.timers.tick(1);
  await done;
  assert.equal(calls.length, 1);
});

test('an unloaded page starts nothing, a restored one starts it', async () => {
  fire('beforeunload');
  fire('pagehide');
  let settled = false;
  const done = request('/api/v1/a').then(() => { settled = true; });
  mock.timers.tick(60_000);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(settled, false);
  fire('pageshow');
  await done;
  assert.equal(calls.length, 1);
});

test('several waiting requests all start, in order, once the page is live', async () => {
  fire('beforeunload');
  const all = Promise.all([request('/api/v1/a'), request('/api/v1/b'), request('/api/v1/c')]);
  await settle();
  assert.equal(calls.length, 0);
  fire('keydown');
  await all;
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/a', '/api/v1/b', '/api/v1/c']);
});

test('a keepalive request, sent on the way out on purpose, does not wait', async () => {
  fire('beforeunload');
  fire('pagehide');
  const done = request('/api/v1/accept', { method: 'POST', body: {}, keepalive: true });
  assert.equal(calls.length, 1, 'sent at once');
  assert.equal(calls[0]?.keepalive, true);
  await done;
});

test('a request aborted while it waits is an AbortError and never starts', async () => {
  fire('beforeunload');
  const controller = new AbortController();
  const done = request('/api/v1/a', { signal: controller.signal });
  await settle();
  controller.abort();
  await assert.rejects(done, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  fire('pointerdown');
  await settle();
  assert.equal(calls.length, 0, 'the page being live again does not start an aborted request');
});

test('a signal that is already aborted while the page is left is an AbortError at once', async () => {
  fire('beforeunload');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request('/api/v1/a', { signal: controller.signal }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls.length, 0);
});

test('real failures stay visible, on a live page and after a wait', async () => {
  respond = async () => { throw new TypeError('Load failed'); };
  await assert.rejects(request('/api/v1/a'), NetworkError);
  respond = async () => Response.json({ code: 'BOOM', message: 'It broke.' }, { status: 500 });
  await assert.rejects(request('/api/v1/a'), (error: unknown) => error instanceof ApiError && error.status === 500 && error.code === 'BOOM');

  fire('beforeunload');
  respond = async () => { throw new TypeError('Load failed'); };
  const failed = request('/api/v1/a');
  fire('pointerdown');
  await assert.rejects(failed, NetworkError);
  assert.equal(calls.length, 3, 'the waiting request was sent, and its failure reached the caller');
});
