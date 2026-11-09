import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ApiError, NetworkError } from '../../apps/web/src/api/client.js';
import { KEEP_RETRY_MS, type PageArgs, forgetKeptPages, keepOnRefresh, keepPagesOnRefresh, retryKeptPagesWith } from '../../apps/web/src/app/keepPage.js';

// #1141: a background read that failed to get an answer replaced the shown page with the error screen. The loader gives back what it last
// read for the same page and asks again quietly; the error screen stays for a first load and for answers that say the data is gone.
let refreshed = 0;
beforeEach(() => {
  forgetKeptPages();
  refreshed = 0;
  retryKeptPagesWith(() => { refreshed += 1; });
});

const args = (path = '/projects/a', params: Record<string, string> = { projectId: 'a' }, signal?: AbortSignal) =>
  ({ params, request: new Request(`http://flux.test${path}`, { signal }) }) as unknown as PageArgs;

type Loading = (args: PageArgs) => Promise<unknown>;
/** A loader that answers with the next of `steps`: a value, or an error to throw. */
function loaderOf(...steps: unknown[]) {
  let calls = 0;
  const loader = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error || step instanceof Response) throw step;
    return step;
  };
  return Object.assign(loader, { calls: () => calls }) as Loading & { calls: () => number };
}

test('a refresh that gets no answer, or a 5xx, gives back what the page shows', async () => {
  for (const failure of [new NetworkError(), new ApiError(503, null, 'Service Unavailable'), new ApiError(500, 'X', 'x'), new ApiError(429, null, 'Too Many Requests')]) {
    forgetKeptPages();
    const shown = { name: 'before' };
    const keep = keepOnRefresh(loaderOf(shown, failure));
    assert.equal(await keep(args()), shown);
    assert.equal(await keep(args()), shown, `${failure.name} keeps the page`);
  }
});

test('a first load that fails, and a different page, still fail', async () => {
  const failure = new ApiError(503, null, 'Service Unavailable');
  await assert.rejects(keepOnRefresh(loaderOf(failure))(args()), failure);
  const keep = keepOnRefresh(loaderOf('a', failure));
  await keep(args('/projects/a'));
  await assert.rejects(keep(args('/projects/b', { projectId: 'b' })), failure, 'another place has nothing to keep');
  await assert.rejects(keep(args('/projects/b', { projectId: 'b' })), failure, 'and nothing of the first is left');
});

test('a page of another search is another page', async () => {
  const failure = new NetworkError();
  const keep = keepOnRefresh(loaderOf('all', failure));
  await keep(args('/tasks', {}));
  await assert.rejects(keep(args('/tasks?status=open', {})), failure);
});

test('401, 403, 404, 423, other 4xx, a thrown response and a plain error go on as they are, and end what was kept', async () => {
  const answers = [new ApiError(401, null, 'x'), new ApiError(403, null, 'x'), new ApiError(404, null, 'x'), new ApiError(423, 'WORKSPACE_LOCKED', 'x'),
    new ApiError(400, null, 'x'), new Response('Not found', { status: 404 }), new Response(null, { status: 302, headers: { location: '/sign-in' } }), new TypeError('a bug')];
  for (const answer of answers) {
    forgetKeptPages();
    const keep = keepOnRefresh(loaderOf('shown', answer, new NetworkError()));
    await keep(args());
    await assert.rejects(keep(args()), (error) => error === answer);
    await assert.rejects(keep(args()), NetworkError, 'what the answer ended is not given back later');
  }
});

test('a loader that returns a redirect keeps nothing', async () => {
  const redirect = new Response(null, { status: 302 });
  let calls = 0;
  const keep = keepOnRefresh((async () => { calls += 1; if (calls === 1) return 'shown'; if (calls === 2) return redirect; throw new NetworkError(); }) as Loading);
  await keep(args());
  assert.equal(await keep(args()), redirect);
  await assert.rejects(keep(args()), NetworkError);
});

test('a read that was stopped says nothing about the page', async () => {
  const stop = new AbortController();
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  const keep = keepOnRefresh(loaderOf('shown', aborted, new NetworkError()));
  await keep(args());
  stop.abort();
  await assert.rejects(keep(args('/projects/a', { projectId: 'a' }, stop.signal)), aborted);
  assert.equal(await keep(args()), 'shown', 'it is still what the page shows');
});

test('the retries wait 1, 2, 4, 8 and 16 s, one at a time, then leave it to the next event or focus', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const keep = keepOnRefresh(loaderOf('shown', new NetworkError()));
  await keep(args());
  await keep(args());
  await keep(args());
  assert.equal(refreshed, 0);
  let waited = 0;
  for (const [index, wait] of KEEP_RETRY_MS.entries()) {
    context.mock.timers.tick(wait - 1);
    assert.equal(refreshed, index, `not before ${wait} ms`);
    context.mock.timers.tick(1);
    waited += wait;
    assert.equal(refreshed, index + 1);
    await keep(args());
  }
  context.mock.timers.tick(60_000);
  assert.equal(refreshed, KEEP_RETRY_MS.length, 'no more of them');
  context.mock.timers.tick(60_000);
  await keep(args());
  context.mock.timers.tick(KEEP_RETRY_MS[0]!);
  assert.equal(refreshed, KEEP_RETRY_MS.length + 1, 'a failure long after the last starts the waits again');
  assert.ok(waited >= 30_000);
});

test('forgetting what is kept ends the retry too', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const failure = new NetworkError();
  const keep = keepOnRefresh(loaderOf('shown', failure));
  await keep(args());
  await keep(args());
  forgetKeptPages();
  context.mock.timers.tick(60_000);
  assert.equal(refreshed, 0);
  await assert.rejects(keep(args()), failure);
});

test('every loader of a route tree is wrapped, and so is the one a lazy route brings', async () => {
  const failure = new ApiError(503, null, 'Service Unavailable');
  const own = loaderOf('own', failure);
  const lazy = loaderOf('lazy', failure);
  const lazyObject = loaderOf('object', failure);
  type Tree = { path?: string; index?: true; loader?: unknown; lazy?: unknown; children?: Tree[] };
  const tree = keepPagesOnRefresh<Tree>({
    path: '/',
    loader: own,
    children: [
      { path: 'a', lazy: async () => ({ loader: lazy }) },
      { path: 'b', lazy: { loader: async () => lazyObject } },
      { path: 'c', lazy: async () => ({ Component: () => null }) },
      { index: true },
    ],
  });
  const call = async (loader: unknown) => (loader as (a: PageArgs) => Promise<unknown>)(args());
  assert.equal(await call(tree.loader), 'own');
  assert.equal(await call(tree.loader), 'own');
  const [a, b, c, index] = tree.children!;
  const loaded = await (a!.lazy as () => Promise<{ loader: unknown }>)();
  assert.equal(await call(loaded.loader), 'lazy');
  assert.equal(await call(loaded.loader), 'lazy');
  const loader = await (b!.lazy as { loader: () => Promise<unknown> }).loader();
  assert.equal(await call(loader), 'object');
  assert.equal(await call(loader), 'object');
  const plain = await (c!.lazy as () => Promise<{ loader?: unknown }>)();
  assert.equal(plain.loader, undefined);
  assert.equal((index as { loader?: unknown }).loader, undefined);
});
