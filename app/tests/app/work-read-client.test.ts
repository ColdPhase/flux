import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectWorkSummary, ProjectWorkView } from '@flux/contracts';
import { ApiError } from '../../apps/web/src/api/client.js';
import {
  getProjectWorkSummary, getProjectWorkView, getWorkAssociations, getWorkDetail, getWorkRelations,
  workAssociationReadUrl, workRelationReadUrl, workViewReadUrl, getWorkReferenceRows, workReferenceReadUrl,
} from '../../apps/web/src/work/read-api.js';
import { ProjectWorkFacetStore, readScopeKey, readStateForScope, ScopedReadStore, type ReadScope } from '../../apps/web/src/work/read-state.js';
import { summaryEmptyCaption, summaryStateParts } from '../../apps/web/src/work/state-summary.js';

const scope: ReadScope = { accountId: 'account-a', projectId: 'project-a', selector: '/view?group=all&limit=50' };
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function summary(open = 0): ProjectWorkSummary {
  const counts = { needs: 0, in_progress: 0, blocked: 0, open, parked: 0, finished: 0, rules: 0, results: 0 };
  return {
    projectId: scope.projectId, observedAt: `2026-10-01T00:00:${String(open).padStart(2, '0')}.000000Z`, access: 'contributor',
    all: { ...counts }, mine: { ...counts }, workTotal: open, unfinishedTotal: open,
    state: { rule: null, proposal: null, active: { count: 0, first: null, owners: [], ownerTotal: 0 }, blocked: { count: 0, first: null }, open: { count: open, first: open ? { kind: 'work', id: 'first-open', title: 'Open native work' } : null },
      history: { completed: 0, notPursued: 0, parked: 0, firstWork: open ? { kind: 'work', id: 'first-open', title: 'Open native work' } : null, decisionCount: 0, firstDecision: null }, result: null },
  };
}
function page(open = 0): ProjectWorkView {
  return { items: [], total: open, before: 0, limit: 50, nextCursor: null, previousCursor: null, summary: summary(open), selected: null };
}

test('late account/project/selector responses cannot replace the current observation, even if transport ignores abort', async () => {
  for (const next of [{ ...scope, accountId: 'account-b' }, { ...scope, projectId: 'project-b' }, { ...scope, selector: '/view?group=blocked' }]) {
    const store = new ScopedReadStore<string>();
    const old = held<string>();
    let oldSignal!: AbortSignal;
    const oldRead = store.read(scope, (signal) => { oldSignal = signal; return old.promise; });
    await store.read(next, async () => 'current');
    assert.equal(oldSignal.aborted, true);
    old.resolve('stale'); await oldRead;
    assert.deepEqual(store.getSnapshot(), { phase: 'ready', scope: next, generation: 2, value: 'current' });
  }
});

test('same-selector refresh fences both late success and failure by generation', async () => {
  for (const fail of [false, true]) {
    const store = new ScopedReadStore<string>();
    const old = held<string>();
    const oldRead = store.read(scope, () => old.promise);
    await store.read(scope, async () => 'refreshed');
    if (fail) old.reject(new Error('late unavailable')); else old.resolve('old');
    await oldRead;
    const state = store.getSnapshot();
    assert.equal(state.phase, 'ready');
    if (state.phase === 'ready') assert.equal(state.value, 'refreshed');
    assert.equal(state.generation, 2);
  }
});

test('clearing/unmounting drops retained data and prevents a held read from reviving it', async () => {
  const store = new ScopedReadStore<string>();
  const old = held<string>();
  const reading = store.read(scope, () => old.promise);
  store.clear();
  old.resolve('private old result'); await reading;
  assert.deepEqual(store.getSnapshot(), { phase: 'idle', scope: null, generation: 2 });
  await store.read(scope, async () => 'strict-mode remount');
  assert.equal(store.getSnapshot().phase, 'ready');
});

test('current failures are unavailable rather than empty data or retained successful pages', async () => {
  const store = new ScopedReadStore<string[]>();
  await store.read(scope, async () => ['prior record']);
  const error = new ApiError(503, 'WORK_READ_UNAVAILABLE', 'Unavailable');
  await store.read(scope, async () => { throw error; });
  assert.deepEqual(store.getSnapshot(), { phase: 'unavailable', scope, generation: 2, error });
  assert.equal('value' in store.getSnapshot(), false);
});

test('same-scope passive refresh retains one observation until atomic replacement, but failure or changed scope clears it', async () => {
  const store = new ScopedReadStore<ProjectWorkView>();
  const old = page(7);
  await store.read(scope, async () => old);
  const pending = held<ProjectWorkView>();
  const reading = store.read(scope, () => pending.promise, true);
  const refreshing = store.getSnapshot();
  assert.equal(refreshing.phase, 'refreshing');
  if (refreshing.phase === 'refreshing') assert.equal(refreshing.value, old);
  const changed = page(8);
  pending.resolve(changed); await reading;
  const current = store.getSnapshot();
  if (current.phase === 'ready') assert.equal(current.value, changed); else assert.fail('replacement is ready');
  const error = new Error('unavailable');
  await store.read(scope, async () => { throw error; }, true);
  assert.equal(store.getSnapshot().phase, 'unavailable');
  assert.equal('value' in store.getSnapshot(), false);
  await store.read(scope, async () => changed);
  const next = held<ProjectWorkView>();
  const nextRead = store.read({ ...scope, accountId: 'other' }, () => next.promise, true);
  assert.equal(store.getSnapshot().phase, 'loading');
  assert.equal('value' in store.getSnapshot(), false);
  next.resolve(page(1)); await nextRead;
});

test('summary state preserves distinct identical owner labels and captions actual open/parked/finished work', () => {
  const observed = summary(105);
  assert.equal(summaryEmptyCaption(observed), '105 work items');
  assert.equal(summaryEmptyCaption(summary()), 'No decisions or work yet');
  observed.all.open = 0; observed.all.parked = 105;
  assert.equal(summaryEmptyCaption(observed), '105 work items');
  observed.all.parked = 0; observed.all.finished = 105;
  assert.equal(summaryEmptyCaption(observed), '105 work items');
  observed.state.active = { count: 12, first: { kind: 'work', id: 'native-work', title: 'Measure low-light noise' }, ownerTotal: 5,
    owners: [{ kind: 'human', id: 'one', name: 'Ada' }, { kind: 'human', id: 'two', name: 'Ada' }, { kind: 'agent', id: 'three', name: 'Ada' }] };
  const part = summaryStateParts(observed, true).find((value) => value.key === 'work');
  assert.equal(part?.text, '12 in progress (Ada, Ada, Ada, 2 others)');
  assert.deepEqual(part?.open, { kind: 'work', id: 'native-work' });
});

test('render-time scope gating hides the old account before effect cancellation runs', async () => {
  const store = new ScopedReadStore<string>();
  await store.read(scope, async () => 'account a data');
  const next = { ...scope, accountId: 'account-b' };
  assert.deepEqual(readStateForScope(store.getSnapshot(), next), { phase: 'loading', scope: next, generation: 1 });
  assert.equal(readStateForScope(store.getSnapshot(), null).phase, 'idle');
  assert.equal(readStateForScope(store.getSnapshot(), scope), store.getSnapshot());
  assert.notEqual(readScopeKey({ accountId: 'a:b', projectId: 'c', selector: 'd' }), readScopeKey({ accountId: 'a', projectId: 'b:c', selector: 'd' }));
});

test('mutable caller scope is captured before an asynchronous read', async () => {
  const store = new ScopedReadStore<string>();
  const mutable = { ...scope };
  const response = held<string>();
  const reading = store.read(mutable, () => response.promise);
  mutable.accountId = 'another account'; mutable.selector = '/different';
  response.resolve('original response'); await reading;
  assert.deepEqual(store.getSnapshot().scope, scope);
  assert.equal(Object.isFrozen(store.getSnapshot().scope), true);
});

test('a synchronous abort listener can start a newer read without an outer read/clear overwriting it', async () => {
  for (const clearing of [false, true]) {
    const store = new ScopedReadStore<string>();
    const first = held<string>();
    let reentrant!: Promise<void>;
    const firstRead = store.read(scope, (signal) => {
      signal.addEventListener('abort', () => {
        reentrant = store.read({ ...scope, selector: '/newest' }, async () => 'newest');
      }, { once: true });
      return first.promise;
    });
    let obsoleteCalls = 0;
    if (clearing) store.clear();
    else await store.read({ ...scope, selector: '/outer' }, async () => { obsoleteCalls++; return 'outer'; });
    await reentrant;
    first.resolve('first'); await firstRead;
    assert.equal(obsoleteCalls, 0);
    const state = store.getSnapshot();
    assert.equal(state.phase, 'ready');
    if (state.phase === 'ready') {
      assert.equal(state.value, 'newest'); assert.equal(state.scope.selector, '/newest');
    }
  }
});

test('a synchronous abort listener clearing state prevents the obsolete replacement from dispatching', async () => {
  const store = new ScopedReadStore<string>();
  const first = held<string>();
  const firstRead = store.read(scope, (signal) => {
    signal.addEventListener('abort', () => { store.clear(); }, { once: true });
    return first.promise;
  });
  let dispatched = false;
  await store.read(scope, async () => { dispatched = true; return 'obsolete'; });
  first.resolve('first'); await firstRead;
  assert.equal(dispatched, false);
  assert.equal(store.getSnapshot().phase, 'idle');
});

test('active page lease fences held and newly requested standalone summaries, and publishes page+summary atomically', async () => {
  const store = new ProjectWorkFacetStore();
  const old = held<ProjectWorkSummary>();
  const summaryRead = store.readSummary(scope, () => old.promise);
  const lease = store.claimPage(scope);
  let standaloneCalls = 0;
  await store.readSummary(scope, async () => { standaloneCalls++; return summary(99); });
  assert.equal(standaloneCalls, 0);
  const observations: ProjectWorkView[] = [];
  const unsubscribe = store.subscribe(() => {
    const state = store.getSnapshot();
    if (state.phase === 'ready' && state.value.kind === 'page') observations.push(state.value.page);
  });
  const combined = page(7);
  await store.readPage(lease, scope, async () => combined);
  old.resolve(summary(99)); await summaryRead;
  assert.deepEqual(observations, [combined]);
  const state = store.getSnapshot();
  assert.equal(state.phase, 'ready');
  if (state.phase === 'ready') assert.deepEqual(state.value, { kind: 'page', page: combined });
  unsubscribe();
});

test('replaced page leases and wrong-account/project page requests cannot write or release the new facet', async () => {
  const store = new ProjectWorkFacetStore();
  const first = store.claimPage(scope);
  const old = held<ProjectWorkView>();
  const oldRead = store.readPage(first, scope, () => old.promise);
  const second = store.claimPage(scope);
  let invalidCalls = 0;
  for (const wrongScope of [{ ...scope, accountId: 'b' }, { ...scope, projectId: 'b' }]) {
    await store.readPage(second, wrongScope, async () => { invalidCalls++; return page(99); });
  }
  await store.readPage(first, scope, async () => { invalidCalls++; return page(99); });
  assert.equal(invalidCalls, 0);
  const current = page(2);
  await store.readPage(second, scope, async () => current);
  store.releasePage(first);
  old.resolve(page(99)); await oldRead;
  const state = store.getSnapshot();
  assert.equal(state.phase, 'ready');
  if (state.phase === 'ready') assert.deepEqual(state.value, { kind: 'page', page: current });
});

test('releasing a page drops its observation, fences held refresh, and permits a new standalone summary', async () => {
  const store = new ProjectWorkFacetStore();
  const lease = store.claimPage(scope);
  const late = held<ProjectWorkView>();
  const reading = store.readPage(lease, scope, () => late.promise);
  store.releasePage(lease);
  assert.equal(store.getSnapshot().phase, 'idle');
  await store.readSummary(scope, async () => summary(3));
  late.resolve(page(99)); await reading;
  const state = store.getSnapshot();
  assert.equal(state.phase, 'ready');
  if (state.phase === 'ready') assert.deepEqual(state.value, { kind: 'summary', summary: summary(3) });
});

test('canonical query builders preserve typed selectors, literal search, independent continuations and raw set bounds', () => {
  assert.equal(workViewReadUrl('project', {}), workViewReadUrl('project', { purpose: 'tasks', group: 'all', mine: false, limit: 50 }));
  const view = new URL(workViewReadUrl('project', { purpose: 'choices', choice: 'result_work', q: '  %_ & title  ', selected: 'chosen', cursor: 'opaque+/=' }), 'http://local');
  assert.deepEqual(Object.fromEntries(view.searchParams), { purpose: 'choices', choice: 'result_work', q: '%_ & title', limit: '50', cursor: 'opaque+/=', selected: 'chosen' });
  for (const query of [
    { purpose: 'choices', choice: 'accepted_decisions' }, { purpose: 'choices', choice: 'pivot_work' },
    { purpose: 'choices', choice: 'parked_work', decisionId: 'native-rule' }, { purpose: 'choices', choice: 'doc_refs', kind: 'result' },
  ] as const) assert.equal(new URL(workViewReadUrl('project', query), 'http://local').searchParams.get('choice'), query.choice);
  const batch = new URL(workAssociationReadUrl('project', { messageIds: 'b,a,b', cursor: 'objects', edgeCursor: 'edges' }), 'http://local');
  assert.deepEqual(Object.fromEntries(batch.searchParams), { relation: 'source', limit: '50', cursor: 'objects', edgeCursor: 'edges', messageIds: 'a,b' });
  const conversation = new URL(workAssociationReadUrl('project', { conversationId: 'native-conversation', sourceCursor: 'sources', relation: 'any' }), 'http://local');
  assert.equal(conversation.searchParams.get('sourceCursor'), 'sources');
  assert.equal(conversation.searchParams.has('messageIds'), false);
  const relations = new URL(workRelationReadUrl('project', { objects: 'work:b,decision:a,work:b', role: 'source', cursor: 'links' }), 'http://local');
  assert.equal(relations.searchParams.get('objects'), 'decision:a,work:b');
  assert.equal(relations.searchParams.get('cursor'), 'links');
  assert.throws(() => workAssociationReadUrl('project', { messageIds: Array(101).fill('same').join(',') }), /1–100/);
  assert.throws(() => workRelationReadUrl('project', { objects: '' }), /1–100/);
  const references = new URL(workReferenceReadUrl('project', 'work:b,work:a,work:b'), 'http://local');
  assert.deepEqual(Object.fromEntries(references.searchParams), { objects: 'work:a,work:b' });
  assert.throws(() => workReferenceReadUrl('project', Array(101).fill('work:a').join(',')), /1–100/);
});

test('six client adapters make one cookie-bearing GET each and preserve failures without collection fallbacks', async (context) => {
  const calls: { path: string; init: RequestInit }[] = [];
  let fail = false;
  const fetchMock = context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify(fail ? { code: 'WORK_READ_UNAVAILABLE', error: 'Required read failed' } : { observed: 'native response' }), { status: fail ? 503 : 200 });
  });
  const signal = new AbortController().signal;
  for (const read of [
    () => getProjectWorkSummary('project', signal),
    () => getProjectWorkView('project', { group: 'blocked', mine: true }, signal),
    () => getWorkAssociations('project', { messageIds: 'message' }, signal),
    () => getWorkRelations('project', { objects: 'work:object' }, signal),
    () => getWorkDetail('project', 'work', 'object', signal),
    () => getWorkReferenceRows('project', 'work:object', signal),
  ]) assert.deepEqual(await read(), { observed: 'native response' });
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET'); assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.signal, signal); assert.equal(call.init.body, undefined);
    assert.doesNotMatch(call.path, /offset=|\/work-items/);
  }
  fail = true;
  await assert.rejects(getProjectWorkView('project'), (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'WORK_READ_UNAVAILABLE');
  assert.equal(calls.length, 7);
  await assert.rejects(getWorkReferenceRows('project', 'work:object'), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(calls.length, 8);
  fetchMock.mock.restore();
});


test('bounded state opens actual open/history refs without labelling history as active or hiding superseded decisions', () => {
  const observed = summary(2);
  assert.equal(summaryStateParts(observed, true)[0]?.text, '2 open tasks');
  assert.deepEqual(summaryStateParts(observed, true)[0]?.open, { kind: 'work', id: 'first-open' });
  observed.all.open = 0; observed.state.open = { count: 0, first: null };
  observed.state.history = { completed: 1, notPursued: 1, parked: 2,
    firstWork: { kind: 'work', id: 'retained', title: 'Retained native work' }, decisionCount: 0, firstDecision: null };
  const history = summaryStateParts(observed, true);
  assert.equal(history.length, 1); assert.equal(history[0]?.key, 'history');
  assert.equal(history[0]?.text, '1 completed task · 1 not pursued · 2 parked');
  assert.deepEqual(history[0]?.open, { kind: 'work', id: 'retained' });
  observed.state.history = { completed: 0, notPursued: 0, parked: 0, firstWork: null,
    decisionCount: 1, firstDecision: { kind: 'decision', id: 'superseded', title: 'Earlier rule' } };
  assert.equal(summaryStateParts(observed, false)[0]?.text, '1 earlier decision');
  assert.deepEqual(summaryStateParts(observed, false)[0]?.open, { kind: 'decision', id: 'superseded' });
  observed.state.proposal = { kind: 'decision', id: 'proposal', title: 'Needs review' };
  assert.equal(summaryStateParts(observed, true)[0]?.tone, 'need', 'current needs-you wins over retained history');
});
