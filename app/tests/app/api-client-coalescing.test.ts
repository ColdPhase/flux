import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetKeptFor, forgetKeptReads, request } from '../../apps/web/src/api/client.js';

// A navigation asked for the same project and people up to four times (#850, #862 target: at most 8 requests, none repeated).
// Reads that ask to share (the project, its people and its docs) and are of one address in flight together are one request; nothing else is shared.
function stub(context: { mock: { method: typeof import('node:test').mock.method } }) {
  const calls: { path: string; method: string; signal: AbortSignal | undefined; finish: (body: unknown, status?: number) => void; done?: boolean }[] = [];
  context.mock.method(globalThis, 'fetch', (input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const call = { path: String(input), method: init.method ?? 'GET', signal: init.signal ?? undefined, finish: (body: unknown, status = 200) => resolve(new Response(JSON.stringify(body), { status })) };
    calls.push(call);
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  return calls;
}
// A read starts in a task of its own (a MessageChannel message), which a loaded machine can deliver a few milliseconds late.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

test('reads of one address in flight together are one request, and each caller gets its own copy', async (context) => {
  const calls = stub(context);
  const first = request<{ items: string[] }>('/api/v1/projects/p', { share: true });
  const second = request<{ items: string[] }>('/api/v1/projects/p', { share: true });
  const other = request<{ other: true }>('/api/v1/projects/p/people', { share: true });
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

test('without keep, an answer that has arrived is never reused: the next read asks again', async (context) => {
  const calls = stub(context);
  const first = request('/api/v1/needs-you', { share: true });
  await settle();
  calls[0]!.finish({ count: 1 });
  await first;
  const again = request('/api/v1/needs-you', { share: true });
  await settle();
  assert.equal(calls.length, 2, 'a second request, so nothing is stale');
  calls[1]!.finish({ count: 2 });
  assert.deepEqual(await again, { count: 2 });
});

test('a write ends the sharing: a read asked for after it never joins one that started before it', async (context) => {
  const calls = stub(context);
  const before = request<{ status: string }>('/api/v1/projects/p/work-view', { share: true });
  await settle();
  const write = request('/api/v1/work/w', { method: 'PATCH', body: { status: 'done' } });
  await settle();
  const after = request<{ status: string }>('/api/v1/projects/p/work-view', { share: true });
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
  const first = request('/api/v1/projects/p/people', { signal: one.signal, share: true });
  const second = request('/api/v1/projects/p/people', { signal: two.signal, share: true });
  await settle();
  assert.equal(calls.length, 1);
  one.abort();
  await assert.rejects(first, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls[0]!.signal?.aborted, false, 'the second caller still waits for it');
  calls[0]!.finish([{ id: 'u' }]);
  assert.deepEqual(await second, [{ id: 'u' }]);

  // Two callers of another read: the request stops when the last of them has left.
  const left = new AbortController(); const right = new AbortController();
  const third = request('/api/v1/projects/p/work-summary', { signal: left.signal, share: true });
  const fourth = request('/api/v1/projects/p/work-summary', { signal: right.signal, share: true });
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
  await assert.rejects(request('/api/v1/me', { signal: gone.signal, share: true }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  const first = request('/api/v1/boom', { share: true });
  const second = request('/api/v1/boom', { share: true });
  await settle();
  const boom = calls.find((call) => call.path === '/api/v1/boom')!;
  boom.finish({ code: 'NOT_FOUND', error: 'Not here' }, 404);
  for (const read of [first, second]) await assert.rejects(read, (error: unknown) => error instanceof Error && error.name === 'ApiError' && (error as { status?: number }).status === 404);
});

test('only reads that ask to share are shared: writes, reads with headers, and reads that do not ask are separate requests', async (context) => {
  const calls = stub(context);
  void request('/api/v1/things', { method: 'POST', body: { a: 1 } }).catch(() => undefined);
  void request('/api/v1/things', { method: 'POST', body: { a: 1 } }).catch(() => undefined);
  void request('/api/v1/things/1', { headers: { 'if-none-match': '"1"' }, share: true }).catch(() => undefined);
  void request('/api/v1/things/1', { headers: { 'if-none-match': '"1"' }, share: true }).catch(() => undefined);
  void request('/api/v1/things/2').catch(() => undefined);
  void request('/api/v1/things/2').catch(() => undefined);
  await settle();
  assert.equal(calls.length, 6, 'nothing here was shared: a view that holds or reorders its own reads needs each answer to be its own');
});

// #862: the reads every view of a space or the shell asks for are kept for a moment, so the next view takes them without a request.
test('a kept answer is given to later callers without a request until it expires; a fresh read asks again and keeps its answer', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const first = request<{ count: number }>('/api/v1/kept/needs-you', { share: true, keep: 40 });
  await settle();
  calls[0]!.finish({ count: 1 });
  assert.deepEqual(await first, { count: 1 });
  const again = await request<{ count: number }>('/api/v1/kept/needs-you', { share: true, keep: 40 });
  assert.deepEqual(again, { count: 1 });
  assert.equal(calls.length, 1, 'the next view took the kept answer');
  again.count = 99;
  assert.deepEqual(await request('/api/v1/kept/needs-you', { share: true, keep: 40 }), { count: 1 }, 'each caller parses its own copy');

  const refresh = request<{ count: number }>('/api/v1/kept/needs-you', { share: true, keep: 40, fresh: true });
  await settle();
  assert.equal(calls.length, 2, 'a refresh (focus, a poll) reads');
  calls[1]!.finish({ count: 2 });
  assert.deepEqual(await refresh, { count: 2 });
  assert.deepEqual(await request('/api/v1/kept/needs-you', { share: true, keep: 40 }), { count: 2 }, 'and keeps what it got');

  await new Promise((resolve) => setTimeout(resolve, 60));
  const expired = request<{ count: number }>('/api/v1/kept/needs-you', { share: true, keep: 40 });
  await settle();
  assert.equal(calls.length, 3, 'an expired answer is not given');
  calls[2]!.finish({ count: 3 });
  assert.deepEqual(await expired, { count: 3 });

  const failed = request('/api/v1/kept/boom', { share: true, keep: 1000 });
  await settle();
  calls[3]!.finish({ code: 'NOT_FOUND', error: 'Not here' }, 404);
  await assert.rejects(failed);
  void request('/api/v1/kept/boom', { share: true, keep: 1000 }).catch(() => undefined);
  await settle();
  assert.equal(calls.length, 5, 'a refused read is never kept');
  const plain = request('/api/v1/kept/plain', { keep: 1000 });
  await settle();
  calls[5]!.finish({ plain: true });
  await plain;
  void request('/api/v1/kept/plain', { keep: 1000 }).catch(() => undefined);
  await settle();
  assert.equal(calls.length, 7, 'only a shared read is kept');
});

test('a write, an event or sign-out forgets kept answers; a write that cannot change them leaves them; an answer read across a write is not kept', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const read = () => request<{ n: number }>('/api/v1/kept/project', { share: true, keep: 10_000 });
  const first = read();
  await settle();
  calls[0]!.finish({ n: 1 });
  await first;

  const receipt = request('/api/v1/return-points', { method: 'PUT', body: {}, leavesReads: true });
  await settle();
  calls[1]!.finish({});
  await receipt;
  assert.deepEqual(await read(), { n: 1 });
  assert.equal(calls.length, 2, 'where the person stopped reading changes no kept answer');

  const write = request('/api/v1/work/w', { method: 'PATCH', body: { status: 'done' } });
  await settle();
  const during = read();
  await settle();
  assert.equal(calls.length, 4, 'the write forgot the kept answer');
  calls[3]!.finish({ n: 2 });
  assert.deepEqual(await during, { n: 2 });
  calls[2]!.finish({});
  await write;
  const after = read();
  await settle();
  assert.equal(calls.length, 5, 'the answer read while the write ran was not kept');
  calls[4]!.finish({ n: 3 });
  assert.deepEqual(await after, { n: 3 });
  assert.deepEqual(await read(), { n: 3 });
  assert.equal(calls.length, 5);

  forgetKeptReads();
  void read().catch(() => undefined);
  await settle();
  assert.equal(calls.length, 6, 'an event of the live stream, a resync or sign-out forgets it too');
});

test('a refusal that says access changed forgets kept answers, so the next read hears it too (a locked workspace, #655)', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const project = request('/api/v1/kept/locked-project', { share: true, keep: 10_000 });
  await settle();
  calls[0]!.finish({ id: 'p' });
  await project;
  const work = request('/api/v1/kept/locked-project/work-view', { share: true });
  await settle();
  calls[1]!.finish({ code: 'WORKSPACE_LOCKED', error: 'Locked' }, 423);
  await assert.rejects(work, (error: unknown) => (error as { status?: number }).status === 423);
  const again = request('/api/v1/kept/locked-project', { share: true, keep: 10_000 });
  await settle();
  assert.equal(calls.length, 3, 'the kept project was forgotten');
  calls[2]!.finish({ code: 'WORKSPACE_LOCKED', error: 'Locked' }, 423);
  await assert.rejects(again, (error: unknown) => (error as { status?: number }).status === 423);
});

test('a 403 refuses what a role may not do and leaves kept answers; an answer kept for one page is not given on the next', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const project = request('/api/v1/kept/guest-project', { share: true, keep: 10_000 });
  await settle();
  calls[0]!.finish({ id: 'p' });
  await project;
  const members = request('/api/v1/kept/guest-members', { share: true });
  await settle();
  calls[1]!.finish({ code: 'FORBIDDEN', error: 'Not for a guest' }, 403);
  await assert.rejects(members, (error: unknown) => (error as { status?: number }).status === 403);
  assert.deepEqual(await request('/api/v1/kept/guest-project', { share: true, keep: 10_000 }), { id: 'p' });
  assert.equal(calls.length, 2, 'a guest who may not list the members still keeps the project');

  const where = globalThis as { location?: { pathname: string } };
  const before = where.location;
  where.location = { pathname: '/inbox' };
  context.after(() => { where.location = before; });
  const queue = () => request<{ count: number }>('/api/v1/kept/one-page-queue', { share: true, keep: 10_000, onePage: true });
  const first = queue();
  await settle();
  calls[2]!.finish({ count: 1 });
  await first;
  assert.deepEqual(await queue(), { count: 1 });
  assert.equal(calls.length, 3, 'the sidebar and the page share one read on the same page');
  where.location = { pathname: '/' };
  const next = queue();
  await settle();
  assert.equal(calls.length, 4, 'the next page reads again (an item handled on another device sends no event here)');
  calls[3]!.finish({ count: 0 });
  assert.deepEqual(await next, { count: 0 });
});

test('a fresh read drops the kept answer, so a caller that asks while it is on its way joins it (the entry into a space)', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const first = request('/api/v1/kept/entered', { share: true, keep: 10_000 });
  await settle();
  calls[0]!.finish({ id: 'p', name: 'Before' });
  await first;
  const shell = request('/api/v1/kept/entered', { share: true, keep: 10_000, fresh: true });
  const view = request('/api/v1/kept/entered', { share: true, keep: 10_000 });
  await settle();
  assert.equal(calls.length, 2, 'one read for the shell and the view');
  calls[1]!.finish({ code: 'NOT_FOUND', error: 'Gone' }, 404);
  for (const read of [shell, view]) await assert.rejects(read, (error: unknown) => (error as { status?: number }).status === 404, 'neither is given the older answer');
});

test('an event forgets only the kept answers it can change: a message none, a page the docs, a run the agents\' chats, a change of access all', async (context) => {
  forgetKeptReads();
  const calls = stub(context);
  const P = '11111111-1111-4111-8111-111111111111';
  const W = '22222222-2222-4222-8222-222222222222';
  const paths = [`/api/v1/projects/${P}`, `/api/v1/projects/${P}/people`, `/api/v1/projects/${P}/docs?limit=100&offset=0`, `/api/v1/workspaces/${W}/members`, '/api/v1/agent-chats'];
  const keepAll = async () => {
    const reads = paths.map((path) => request(path, { share: true, keep: 10_000 }));
    await settle();
    for (const call of calls.filter((item) => !item.done)) { call.done = true; call.finish({ path: call.path }); }
    await Promise.all(reads);
  };
  const asked = async () => {
    const before = calls.length;
    const reads = paths.map((path) => request(path, { share: true, keep: 10_000 }));
    await settle();
    const fresh = calls.slice(before).map((call) => call.path);
    for (const call of calls.filter((item) => !item.done)) { call.done = true; call.finish({ path: call.path }); }
    await Promise.all(reads);
    return fresh;
  };
  const event = (kind: string, objectType = 'project', objectId = P) => ({ kind, objectType, objectId, workspaceId: W });
  await keepAll();
  forgetKeptFor(event('project.message_sent.v1'));
  forgetKeptFor(event('project.work_updated.v1'));
  forgetKeptFor(event('project.messages_observed.v1'));
  forgetKeptFor(event('dm.message_sent.v1', 'dm', randomId()));
  forgetKeptFor(event('project.live_changed.v1'));
  assert.deepEqual(await asked(), [], 'a message, a task, a sight of a message, a direct message or a call changes nothing kept');
  forgetKeptFor(event('project.doc_updated.v1'));
  assert.deepEqual(await asked(), [`/api/v1/projects/${P}/docs?limit=100&offset=0`], 'a page of the space: its pages');
  forgetKeptFor(event('assistant_run.changed.v1', 'assistant_run', randomId()));
  assert.deepEqual(await asked(), ['/api/v1/agent-chats'], 'an agent\'s run: the agents\' chats');
  forgetKeptFor(event('project.grant_set.v1'));
  assert.deepEqual((await asked()).sort(), [...paths].sort(), 'someone added to the space: everything');
  forgetKeptFor(event('workspace.member_role_changed.v1', 'workspace', W));
  assert.deepEqual((await asked()).sort(), [...paths].sort(), 'a change in the company: everything');
});

function randomId() { return '33333333-3333-4333-8333-333333333333'; }
