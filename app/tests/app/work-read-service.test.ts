import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBoundedWorkReads, DomainError, encodeWorkReadCursor, ForbiddenError, NotFoundError, workReadScope,
  type Principal, type WorkReadFinalFence, type WorkReadPorts, type WorkReadRepository,
  type WorkReadSlice, type WorkReadUnitOfWork, type WorkSummaryObservation,
} from '@flux/core';
import type { ObjectLink, SourceAssociationCounts, WorkRowProjection } from '@flux/contracts';

// These are port-protocol tests. Native DB ordering, policies and HTTP sessions need integration tests.
const projectId = '00000000-0000-0000-0000-000000000001';
const workspaceId = '00000000-0000-0000-0000-000000000002';
const id = '00000000-0000-0000-0000-000000000003';
const otherId = '00000000-0000-0000-0000-000000000004';
const messageId = '00000000-0000-0000-0000-000000000005';
const at = '2026-10-01T06:00:00.123456Z';
const actor = { kind: 'human' as const, id: 'native-user' };
const fingerprint = 'a'.repeat(64);
const relations = { edges: 0, sourceMessages: 0, sourceMaterials: 0, decisions: 0, results: 0 };
const row = (rowId = id): WorkRowProjection => ({ kind: 'work', id: rowId, projectId, workspaceId, audience: { kind: 'project', projectId }, title: 'Native work', createdAt: at,
  relations, prerequisiteCounts: { total: 0, unmet: 0 }, status: 'open', owner: null, blocker: null, parked: null, parkedBy: null, rule: null, version: 1, updatedAt: at });
const slice = <T>(items: T[], total = items.length, before = 0): WorkReadSlice<T> => ({ items: items.map((value, i) => ({ value, key: { rank: 0, createdAt: at, id: i ? otherId : id } })), total, before, hasBefore: before > 0, hasAfter: before + items.length < total });
const summary = (): WorkSummaryObservation => ({ projectId, observedAt: at,
  all: { needs: 0, in_progress: 0, blocked: 0, open: 2, parked: 0, finished: 0, rules: 0, results: 0 },
  mine: { needs: 0, in_progress: 0, blocked: 0, open: 0, parked: 0, finished: 0, rules: 0, results: 0 }, workTotal: 2, unfinishedTotal: 2,
  state: { rule: null, proposal: null, active: { count: 0, first: null, owners: [], ownerTotal: 0 }, blocked: { count: 0, first: null }, open: { count: 2, first: { kind: 'work', id, title: 'Native work' } },
    history: { completed: 0, notPursued: 0, parked: 0, firstWork: { kind: 'work', id, title: 'Native work' }, decisionCount: 0, firstDecision: null }, result: null } });

function harness(overrides: Partial<WorkReadRepository> = {}, fence?: WorkReadFinalFence) {
  const calls: string[] = [];
  const notUsed = async (): Promise<never> => { throw new Error('Unexpected repository read'); };
  const rows: WorkReadRepository = {
    observedAt: async () => { calls.push('observation'); return at; },
    sourceVisibilityFingerprint: async () => { calls.push('visibility'); return fingerprint; },
    summary: async () => { calls.push('summary'); return summary(); },
    view: async () => { calls.push('view'); return slice([row()], 2); },
    selectedWork: notUsed, references: notUsed, thoughtTasks: notUsed, detail: notUsed, relations: notUsed, requireSources: notUsed,
    associationObjects: notUsed, associationSources: notUsed, associationEdges: notUsed, associationEdgeTotal: notUsed,
    ...overrides,
  };
  const ports: WorkReadPorts = { rows, access: { requireProject: async () => { calls.push('project-policy'); return { workspaceId, access: 'contributor' }; } } };
  let inTransaction = false;
  const unit: WorkReadUnitOfWork = { run: async (read) => {
    calls.push('tx-start'); inTransaction = true;
    try { return await read(ports); } finally { inTransaction = false; calls.push('tx-end'); }
  } };
  const final: WorkReadFinalFence = fence ?? { check: async (principal, pid, digest) => {
    calls.push('final-fence'); assert.equal(inTransaction, false); assert.deepEqual(principal, actor);
    assert.equal(pid, projectId); assert.equal(digest, fingerprint); return 'viewer';
  } };
  return { calls, ports, reads: createBoundedWorkReads(unit, final) };
}

test('combined view and summary share one observation and use access checked after its transaction', async () => {
  const { reads, calls } = harness();
  const view = await reads.view(actor, projectId, new URLSearchParams('limit=1'));
  assert.equal(view.total, 2); assert.equal(view.summary.workTotal, 2); assert.equal(view.summary.access, 'viewer');
  assert.equal(view.summary.observedAt, at); assert.ok(view.nextCursor); assert.equal(view.selected, null);
  assert.deepEqual(calls, ['tx-start', 'project-policy', 'observation', 'visibility', 'view', 'summary', 'tx-end', 'final-fence']);
});

test('caller and query are captured before asynchronous work; result deep selection never changes its eligible page', async () => {
  const principal: Principal = { ...actor };
  const query = new URLSearchParams(`purpose=choices&choice=result_work&selected=${otherId}&limit=1`);
  const { reads } = harness({
    view: async (_pid, caller, selection, limit) => { assert.deepEqual(caller, actor); assert.equal(limit, 1); assert.deepEqual(selection, { purpose: 'choices', choice: 'result_work', q: '', selected: otherId }); return slice([row()], 2); },
    selectedWork: async (_pid, selectedId) => { assert.equal(selectedId, otherId); return { ...row(otherId), status: 'done' }; },
  });
  const pending = reads.view(principal, projectId, query);
  principal.id = 'different-account'; query.set('limit', '100'); query.set('selected', id);
  const response = await pending;
  assert.equal(response.items.length, 1); assert.equal(response.total, 2); assert.equal(response.selected?.id, otherId);
});

test('invalid requests and scope-mismatched cursors do no policy or repository work', async () => {
  const { reads, calls } = harness();
  const wrong = encodeWorkReadCursor('next', workReadScope('work-view', projectId, { ...actor, id: 'other' }, { purpose: 'tasks', group: 'all', mine: false }, 1), { rank: 0, createdAt: at, id });
  for (const query of ['limit=101', `cursor=${wrong}&limit=1`, 'limit=1&limit=1']) await assert.rejects(reads.view(actor, projectId, new URLSearchParams(query)), { status: 400 });
  await assert.rejects(reads.associations(actor, projectId, new URLSearchParams('messageIds='+Array(101).fill(messageId).join(','))), { status: 400 });
  assert.deepEqual(calls, []);
});

test('project denial precedes reads; failed required data becomes unavailable, never zero or a partial result', async () => {
  const denied = harness();
  denied.ports.access.requireProject = async () => { throw new NotFoundError('Project'); };
  await assert.rejects(denied.reads.summary(actor, projectId), { status: 404 });
  assert.deepEqual(denied.calls, ['tx-start', 'tx-end']);
  const broken = harness({ summary: async () => { throw new Error('Database disconnected'); } });
  await assert.rejects(broken.reads.view(actor, projectId, new URLSearchParams('limit=1')), { status: 503, code: 'WORK_READ_UNAVAILABLE' });
  assert.equal(broken.calls.includes('final-fence'), false);
  const drift = harness({ summary: async () => ({ ...summary(), observedAt: 'another-observation' }) });
  await assert.rejects(drift.reads.view(actor, projectId, new URLSearchParams('limit=1')), { status: 503 });
});

test('revocation at the final fence suppresses the whole assembled response', async () => {
  const { reads, calls } = harness({}, { check: async () => { calls.push('revoked'); throw new ForbiddenError(); } });
  await assert.rejects(reads.view(actor, projectId, new URLSearchParams('limit=1')), { status: 403 });
  assert.ok(calls.indexOf('revoked') > calls.indexOf('tx-end'));
});

test('every required message is validated even when it has no edges, before association counts and hydration', async () => {
  const { reads, calls } = harness({ requireSources: async () => { calls.push('source-policy'); throw new NotFoundError('Source'); } });
  await assert.rejects(reads.associations(actor, projectId, new URLSearchParams(`messageIds=${messageId}`)), { status: 404 });
  assert.deepEqual(calls, ['tx-start', 'project-policy', 'source-policy', 'tx-end']);
});

test('required final-fence failures become unavailable; native session and scope rejection stay exact', async () => {
  const failed = harness({}, { check: async () => { throw new Error('Current-policy database disconnected'); } });
  await assert.rejects(failed.reads.summary(actor, projectId), { status: 503, code: 'WORK_READ_UNAVAILABLE' });
  for (const error of [new DomainError(401, 'UNAUTHENTICATED', 'Session expired'), new DomainError(409, 'work_read_changed', 'Source scope changed')]) {
    const rejected = harness({}, { check: async () => { throw error; } });
    await assert.rejects(rejected.reads.summary(actor, projectId), (actual) => actual === error);
  }
});

test('association rows, all-source counts and global edges keep independent bounded scopes', async () => {
  const edge: ObjectLink = { id: otherId, projectId, role: 'source', from: { type: 'work', id }, to: { type: 'message', id: messageId }, fromTitle: 'Native work', toTitle: 'Source', conversationId: otherId, sketchId: null, createdAt: at };
  const sources: SourceAssociationCounts[] = [{ messageId, work: 2, decisions: 0, results: 0, edges: 3 }, { messageId: otherId, work: 0, decisions: 0, results: 0, edges: 0 }];
  const { reads, calls } = harness({
    requireSources: async () => { calls.push('source-policy'); },
    associationObjects: async (_pid, _selection, limit) => { calls.push('objects'); assert.equal(limit, 1); return slice([row()], 2); },
    associationSources: async () => slice(sources),
    associationEdges: async (_pid, _selection, objects, limit) => { assert.equal(limit, 1); assert.deepEqual(objects, [{ kind: 'work', id }]); return slice([edge]); },
    associationEdgeTotal: async () => 3,
  });
  const response = await reads.associations(actor, projectId, new URLSearchParams(`messageIds=${messageId},${otherId}&limit=1`));
  assert.equal(response.items.length, 1); assert.equal(response.total, 2); assert.equal(response.sourceTotal, 2);
  assert.equal(response.sources[1]?.edges, 0); assert.equal(response.edges.limit, 1); assert.equal(response.edges.total, 1); assert.equal(response.edgeTotal, 3);
  assert.equal(response.sourceNextCursor, null); assert.ok(calls.indexOf('source-policy') < calls.indexOf('objects'));
});

test('an edge continuation fails on a changed object window before any edge or source hydration', async () => {
  const selection = { relation: 'source', messageIds: [messageId] };
  const scope = workReadScope('work-association-edges', projectId, actor, selection, 50, [{ kind: 'work', id }]);
  const edgeCursor = encodeWorkReadCursor('next', scope, { rank: 0, createdAt: at, id });
  const { reads } = harness({ requireSources: async () => {}, associationObjects: async () => slice([row(otherId)]) });
  await assert.rejects(reads.associations(actor, projectId, new URLSearchParams(`messageIds=${messageId}&edgeCursor=${edgeCursor}`)), { status: 400, code: 'INVALID_WORK_READ' });
});

test('all required selectors reach the outside fence as the original normalized request', async () => {
  const captured: unknown[] = [];
  const { reads } = harness({
    selectedWork: async () => row(otherId),
    requireSources: async () => {},
    associationObjects: async () => slice<WorkRowProjection>([]),
    associationSources: async () => ({ ...slice([{ messageId, work: 0, decisions: 0, results: 0, edges: 0 }]), items: [{ key: { rank: 0, createdAt: at, id: messageId }, value: { messageId, work: 0, decisions: 0, results: 0, edges: 0 } }] }),
    associationEdges: async () => slice<ObjectLink>([]), associationEdgeTotal: async () => 0,
    relations: async () => ({ page: slice<ObjectLink>([]), observedAt: at }),
    detail: async () => ({ object: { kind: 'work', id, projectId, workspaceId, audience: { kind: 'project', projectId }, title: 'Own native work', outcome: '', criteria: [], dependencyIds: [], prerequisites: [], planIntent: null, status: 'open', owner: null, blocker: null, parked: null, version: 1, createdAt: at, updatedAt: at, createdBy: { ...actor, name: 'Native' } }, observedAt: at, relations, context: [] }),
  }, { check: async (_principal, _pid, _digest, required) => { captured.push(required); return 'viewer'; } });
  await reads.detail(actor, projectId, 'work', id);
  await reads.relations(actor, projectId, new URLSearchParams(`objects=work:${id}`));
  await reads.view(actor, projectId, new URLSearchParams(`purpose=choices&choice=parked_work&decisionId=${otherId}`));
  await reads.view(actor, projectId, new URLSearchParams(`purpose=choices&choice=result_work&selected=${otherId}`));
  await reads.associations(actor, projectId, new URLSearchParams(`messageIds=${messageId}`));
  assert.deepEqual(captured, [{ objects: [{ kind: 'work', id }] }, { objects: [{ kind: 'work', id }] }, { parkedDecisionId: otherId }, { objects: [{ kind: 'work', id: otherId }] }, { sources: { relation: 'source', messageIds: [messageId] } }]);
});


test('incoherent native open/history counts and absent refs fail closed before publication', async () => {
  for (const corrupt of [
    (v: WorkSummaryObservation) => { v.state.open.count = 1; },
    (v: WorkSummaryObservation) => { v.state.open.first = null; },
    (v: WorkSummaryObservation) => { v.state.history.completed = 1; },
    (v: WorkSummaryObservation) => { v.state.history.parked = 1; },
    (v: WorkSummaryObservation) => { v.state.history.firstWork = null; },
    (v: WorkSummaryObservation) => { v.state.history.decisionCount = 1; },
  ]) {
    const { reads, calls } = harness({ summary: async () => { const value = summary(); corrupt(value); return value; } });
    await assert.rejects(reads.summary(actor, projectId), (error: unknown) => error instanceof DomainError && error.code === 'WORK_READ_UNAVAILABLE');
    assert.equal(calls.includes('final-fence'), false, 'an inconsistent observation is never published');
  }
});


test('invalid direct prerequisite counts fail closed before the final fence', async () => {
  for (const prerequisiteCounts of [{ total: -1, unmet: 0 }, { total: 1, unmet: 2 }, { total: 51, unmet: 0 }, { total: 2, unmet: 0.5 }]) {
    const { reads, calls } = harness({ view: async () => slice([{ ...row(), prerequisiteCounts }]) });
    await assert.rejects(reads.view(actor, projectId, new URLSearchParams()),
      (error: unknown) => error instanceof DomainError && error.code === 'WORK_READ_UNAVAILABLE');
    assert.equal(calls.includes('final-fence'), false);
  }
});

test('mixed references release exact canonical row/marker accounting with their bounded final requirement', async () => {
  let captured: unknown;
  const { reads } = harness({ references: async (_projectId, objects) => {
    assert.deepEqual(objects, [{ kind: 'work', id }, { kind: 'work', id: otherId }]);
    return { items: [row()], unavailable: [{ kind: 'work', id: otherId }] };
  } }, { check: async (_actor, _projectId, _digest, required) => { captured = required; return 'viewer'; } });
  const result = await reads.references(actor, projectId, new URLSearchParams(`objects=work:${otherId},work:${id},work:${id}`));
  assert.equal(result.access, 'viewer'); assert.equal(result.observedAt, at);
  assert.deepEqual(result.unavailable, [{ kind: 'work', id: otherId }]);
  assert.deepEqual(captured, { references: { objects: [{ kind: 'work', id }, { kind: 'work', id: otherId }], available: [{ kind: 'work', id }] } });
});

test('reference omissions, duplicates, opaque marker metadata and failed hydration never become successful partial rows', async () => {
  for (const references of [
    async () => ({ items: [row()], unavailable: [] }),
    async () => ({ items: [row()], unavailable: [{ kind: 'work' as const, id }] }),
    async () => ({ items: [row()], unavailable: [{ kind: 'work' as const, id: otherId, reason: 'foreign' }] }),
    async () => ({ items: [row(otherId), row()], unavailable: [] }),
    async () => { throw new Error('Native SQL failed'); },
  ]) {
    const { reads, calls } = harness({ references });
    await assert.rejects(reads.references(actor, projectId, new URLSearchParams(`objects=work:${id},work:${otherId}`)),
      (error: unknown) => error instanceof DomainError && error.status === 503 && error.code === 'WORK_READ_UNAVAILABLE');
    assert.equal(calls.includes('final-fence'), false);
  }
});

test('thought tasks: bounded parse, coherent observation and the thought set reaches the final fence (#170)', async () => {
  const thoughtA = '00000000-0000-0000-0000-00000000000a', thoughtB = '00000000-0000-0000-0000-00000000000b';
  const task = { ...row(), createdBy: { kind: 'human' as const, id: 'native-user', name: 'Ada' } };
  let required: unknown;
  const fence: WorkReadFinalFence = { check: async (_principal, _pid, _digest, value) => { required = value; return 'viewer'; } };
  const { reads } = harness({ thoughtTasks: async (_pid, ids) => {
    assert.deepEqual(ids, [thoughtA, thoughtB]);
    return { visible: [thoughtA], counts: [{ thoughtId: thoughtA, tasks: 1 }], links: [{ thoughtId: thoughtA, workId: id }], linkTotal: 1, items: [task] };
  } }, fence);
  const value = await reads.thoughtTasks(actor, projectId, new URLSearchParams(`thoughtIds=${thoughtB.toUpperCase()},${thoughtA},${thoughtB}`));
  assert.deepEqual(value.counts, [{ thoughtId: thoughtA, tasks: 1 }]); assert.equal(value.access, 'viewer'); assert.equal('visible' in value, false);
  assert.deepEqual(required, { thoughts: { requested: [thoughtA, thoughtB], visible: [thoughtA] } });
  for (const bad of ['', `thoughtIds=${Array(101).fill(thoughtA).join(',')}`, `thoughtIds=${thoughtA}&limit=1`, 'thoughtIds=nope'])
    await assert.rejects(reads.thoughtTasks(actor, projectId, new URLSearchParams(bad)), { status: 400 });
  const incoherent = [
    { visible: [thoughtA], counts: [{ thoughtId: thoughtB, tasks: 1 }], links: [], linkTotal: 1, items: [] },
    { visible: [thoughtA], counts: [{ thoughtId: thoughtA, tasks: 1 }], links: [{ thoughtId: thoughtA, workId: id }], linkTotal: 2, items: [task] },
    { visible: [thoughtA], counts: [{ thoughtId: thoughtA, tasks: 1 }], links: [{ thoughtId: thoughtA, workId: otherId }], linkTotal: 1, items: [task] },
  ];
  for (const observation of incoherent) {
    const broken = harness({ thoughtTasks: async () => observation }, fence);
    await assert.rejects(broken.reads.thoughtTasks(actor, projectId, new URLSearchParams(`thoughtIds=${thoughtA}`)), { code: 'WORK_READ_UNAVAILABLE' });
  }
});
