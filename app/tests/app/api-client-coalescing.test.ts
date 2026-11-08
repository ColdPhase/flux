import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from '../../apps/web/src/api/client.js';

// A navigation asked for the same project and people up to four times (#850, #862 target: at most 8 requests, none repeated).
// Plain reads of one address that are in flight together share one request; nothing else is shared.
function stub(context: { mock: { method: typeof import('node:test').mock.method } }) {
  const calls: { path: string; method: string; signal: AbortSignal | undefined; finish: (body: unknown, status?: number) => void }[] = [];
  context.mock.method(globalThis, 'fetch', (input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const call = { path: String(input), method: init.method ?? 'GET', signal: init.signal ?? undefined, finish: (body: unknown, status = 200) => resolve(new Response(JSON.stringify(body), { status })) };
    calls.push(call);
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  return calls;
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('reads of one address in flight together are one request, and each caller gets its own copy', async (context) => {
  const calls = stub(context);
  const first = request<{ items: string[] }>('/api/v1/projects/p');
  const second = request<{ items: string[] }>('/api/v1/projects/p');
  const other = request<{ other: true }>('/api/v1/projects/p/people');
  await settle();
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/projects/p', '/api/v1/projects/p/people'], 'one for the project, one for the people');
  calls[0]!.finish({ items: ['a'] });
  calls[1]!.finish({ other: true });
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, { items: ['a'] });
  one.items.push('changed by the first caller');
  assert.deepEqual(two, { items: ['a'] }, 'the second caller was not touched');
  assert.deepEqual(await other, { other: true });
});

test('an answer that has arrived is never reused: the next read asks again', async (context) => {
  const calls = stub(context);
  const first = request('/api/v1/needs-you');
  await settle();
  calls[0]!.finish({ count: 1 });
  await first;
  const again = request('/api/v1/needs-you');
  await settle();
  assert.equal(calls.length, 2, 'a second request, so nothing is stale');
  calls[1]!.finish({ count: 2 });
  assert.deepEqual(await again, { count: 2 });
});

test('a write ends the sharing: a read asked for after it never joins one that started before it', async (context) => {
  const calls = stub(context);
  const before = request<{ status: string }>('/api/v1/projects/p/work-view');
  await settle();
  const write = request('/api/v1/work/w', { method: 'PATCH', body: { status: 'done' } });
  await settle();
  const after = request<{ status: string }>('/api/v1/projects/p/work-view');
  await settle();
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /api/v1/projects/p/work-view', 'PATCH /api/v1/work/w', 'GET /api/v1/projects/p/work-view'],
    'the read after the write is its own request');
  calls[0]!.finish({ status: 'open' });
  calls[1]!.finish({});
  calls[2]!.finish({ status: 'done' });
  assert.deepEqual(await before, { status: 'open' });
  await write;
  assert.deepEqual(await after, { status: 'done' }, 'and answers with what the write left');
});

test('a caller that aborts leaves the others their answer, and the request stops only when every caller has left', async (context) => {
  const calls = stub(context);
  const one = new AbortController(); const two = new AbortController();
  const first = request('/api/v1/projects/p/people', { signal: one.signal });
  const second = request('/api/v1/projects/p/people', { signal: two.signal });
  await settle();
  assert.equal(calls.length, 1);
  one.abort();
  await assert.rejects(first, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls[0]!.signal?.aborted, false, 'the second caller still waits for it');
  calls[0]!.finish([{ id: 'u' }]);
  assert.deepEqual(await second, [{ id: 'u' }]);

  // Two callers of another read: the request stops when the last of them has left.
  const left = new AbortController(); const right = new AbortController();
  const third = request('/api/v1/projects/p/work-summary', { signal: left.signal });
  const fourth = request('/api/v1/projects/p/work-summary', { signal: right.signal });
  void third.catch(() => undefined); void fourth.catch(() => undefined);
  await settle();
  assert.equal(calls.length, 2, 'the summary was asked once for both');
  left.abort();
  await settle();
  assert.equal(calls[1]!.signal?.aborted, false, 'the other caller has not left');
  right.abort();
  await settle();
  assert.equal(calls[1]!.signal?.aborted, true, 'the last caller left, so the request stops');
});

test('a read whose caller is already aborted never reaches the server answer, and errors reach every caller', async (context) => {
  const calls = stub(context);
  const gone = new AbortController(); gone.abort();
  await assert.rejects(request('/api/v1/me', { signal: gone.signal }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  const first = request('/api/v1/boom');
  const second = request('/api/v1/boom');
  await settle();
  const boom = calls.find((call) => call.path === '/api/v1/boom')!;
  boom.finish({ code: 'NOT_FOUND', error: 'Not here' }, 404);
  for (const read of [first, second]) await assert.rejects(read, (error: unknown) => error instanceof Error && error.name === 'ApiError' && (error as { status?: number }).status === 404);
});

test('only plain reads are shared: writes, reads with headers and the same address once the first is done are separate requests', async (context) => {
  const calls = stub(context);
  void request('/api/v1/things', { method: 'POST', body: { a: 1 } }).catch(() => undefined);
  void request('/api/v1/things', { method: 'POST', body: { a: 1 } }).catch(() => undefined);
  void request('/api/v1/things/1', { headers: { 'if-none-match': '"1"' } }).catch(() => undefined);
  void request('/api/v1/things/1', { headers: { 'if-none-match': '"1"' } }).catch(() => undefined);
  await settle();
  assert.equal(calls.length, 4);
});
