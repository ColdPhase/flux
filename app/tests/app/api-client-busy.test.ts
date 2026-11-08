import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

// The web API client when the API answers 429 (the floor of rate limits, #838; review of #1008): a read waits the Retry-After and asks
// again, with the page told ("Flux is busy"); a write is never sent twice by itself; after three waits the answer is given as it is;
// a socket holds its reconnect for the rest of the wait. A fake window and fetch drive the real client.
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { window: globals.window, fetch: globals.fetch, MessageChannel: globals.MessageChannel };
class TaskChannel {
  port1: { onmessage: (() => void) | null } = { onmessage: null };
  port2 = { postMessage: () => { setImmediate(() => this.port1.onmessage?.()); } };
}
globals.MessageChannel = TaskChannel;
globals.window = Object.assign(new EventTarget(), {
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
});
const { request, ApiError } = await import('../../apps/web/src/api/client.js');
const { BUSY_RETRIES, busyRemainingMs, busyUntil, busyWaitMs, reconnectDelay } = await import('../../apps/web/src/api/busy.js');

const calls: Array<{ method: string }> = [];
let answers: Array<() => Response> = [];
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const flush = async () => { for (let n = 0; n < 6; n += 1) await settle(); };
const busy = (seconds: number | null = 2) => () => new Response(JSON.stringify({ code: 'RATE_LIMITED', error: 'Too many requests. Try again shortly.' }),
  { status: 429, headers: { 'content-type': 'application/json', ...(seconds === null ? {} : { 'retry-after': String(seconds) }) } });
const fine = () => Response.json({ ok: true });

beforeEach(() => {
  calls.length = 0;
  answers = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  globals.fetch = async (_path: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET' });
    return (answers.shift() ?? fine)();
  };
});
afterEach(() => { mock.timers.reset(); globals.fetch = saved.fetch; });
after(() => { globals.window = saved.window; globals.MessageChannel = saved.MessageChannel; });

test('a read that gets a 429 waits its Retry-After, the page says so meanwhile, and the read is asked again', async () => {
  answers = [busy(2), fine];
  const done = request<{ ok: boolean }>('/api/v1/a');
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(busyUntil() > 0, 'the page is told Flux is busy');
  assert.ok(busyRemainingMs() >= 2000 && busyRemainingMs() <= 2750 + 1, 'the wait is the Retry-After plus a little jitter');
  assert.equal(reconnectDelay(600), busyRemainingMs(), 'a socket holds its reconnect for the rest of the wait');
  assert.equal(reconnectDelay(60_000), 60_000, 'a longer backoff of its own stands');
  mock.timers.tick(3000);
  assert.deepEqual(await done, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(busyUntil(), 0, 'the notice is gone');
  assert.equal(reconnectDelay(600), 600);
});

test('a write that gets a 429 is not sent again by itself: the person sees the answer and decides', async () => {
  answers = [busy(1), fine];
  await assert.rejects(request('/api/v1/b', { method: 'POST', body: { a: 1 } }), (error: unknown) => error instanceof ApiError && error.status === 429 && error.code === 'RATE_LIMITED');
  assert.equal(calls.length, 1);
  assert.equal(busyUntil(), 0);
});

test('after the waits are spent the read is answered as it is, a 429 the page can show calmly', async () => {
  answers = Array.from({ length: BUSY_RETRIES + 2 }, () => busy(1));
  const done = request('/api/v1/a').then(() => 'fine', (error: unknown) => error);
  for (let wait = 0; wait < BUSY_RETRIES; wait += 1) { await flush(); mock.timers.tick(2000); }
  const error = await done;
  assert.ok(error instanceof ApiError && error.status === 429);
  assert.equal(calls.length, BUSY_RETRIES + 1, 'the first ask and one more after each wait');
  assert.equal(busyUntil(), 0);
});

test('leaving the page ends a wait at once and asks nothing more', async () => {
  answers = [busy(30), fine];
  const controller = new AbortController();
  const done = request('/api/v1/a', { signal: controller.signal });
  await flush();
  assert.ok(busyUntil() > 0);
  controller.abort();
  await assert.rejects(done, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(busyUntil(), 0);
  assert.equal(calls.length, 1);
});

test('the wait is what the API asked: whole seconds from 1 to 60, two seconds when it said nothing', () => {
  const wait = (value: string | null, random = 0) => busyWaitMs({ headers: new Headers(value === null ? {} : { 'retry-after': value }) }, () => random);
  assert.equal(wait('7'), 7000);
  assert.equal(wait('0'), 2000);
  assert.equal(wait('3600'), 60_000);
  assert.equal(wait(null), 2000);
  assert.equal(wait('abc'), 2000);
  assert.equal(wait('5', 0.999), 5000 + 749);
});
