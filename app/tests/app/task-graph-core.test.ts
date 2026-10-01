import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WORK_LIMITS, type WorkStatus } from '@flux/contracts';
import { assertNoDependencyCycle, assertPrerequisitesMet, creationFingerprint, decidePlanIntent, directPrerequisiteIds, DomainError,
  ELIGIBLE_STATUSES, lockProjectGraphs, sortedIds, TASK_GRAPH_LIMIT, taskCriteria, taskDependencyIds, taskPlanIntent, unmetPrerequisites,
  type PrerequisiteState, type TaskGraphReader } from '@flux/core';

// Pure rules of the native task plan (#152): bounded fields, lock normalization, cycle detection,
// start eligibility and the plan-intent decision. SQL, locks and the command are covered by task-plan.test.ts.

const id = () => randomUUID();
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

/** An in-memory graph: task -> its direct prerequisites. Counts reads so the traversal bound is visible. */
function graph(edges: Record<string, string[]> = {}, states: Record<string, { status: WorkStatus; parked?: boolean }> = {}) {
  const calls: string[][] = [];
  const locked: string[][] = [];
  const reader: TaskGraphReader = {
    async lockTaskGraphs(projectIds) { locked.push([...projectIds]); },
    async directPrerequisiteIds(_workspace, taskIds, limit) {
      calls.push([...taskIds]);
      return [...new Set(taskIds.flatMap((task) => edges[task] ?? []))].sort().slice(0, limit);
    },
    async prerequisiteStates(_workspace, taskId) {
      if (!(taskId in edges) && !(taskId in states)) return null;
      return { projectId: 'p', prerequisites: (edges[taskId] ?? []).map((prerequisite): PrerequisiteState => {
        const state = states[prerequisite];
        return { id: prerequisite, status: state?.status ?? null, parked: state?.parked ?? false };
      }) };
    },
  };
  return { reader, calls, locked, edges };
}

test('criteria are trimmed, distinct statements: at most 20, each 1-1000 characters; more or longer is refused, never cut', () => {
  assert.deepEqual(taskCriteria(undefined), []);
  assert.deepEqual(taskCriteria(['  Measure at 5 lux ', 'Measure at 5 lux', 'Photograph the setup\n']), ['Measure at 5 lux', 'Photograph the setup']);
  const twenty = Array.from({ length: WORK_LIMITS.criteria }, (_, index) => `criterion ${index}`);
  assert.equal(taskCriteria(twenty).length, 20);
  assert.equal(taskCriteria([...twenty.slice(0, 19), twenty[0]]).length, 19, 'a duplicate collapses before it is counted');
  assert.equal(taskCriteria(['x'.repeat(WORK_LIMITS.criterion), `  ${'y'.repeat(WORK_LIMITS.criterion)}  `]).length, 2);
  for (const bad of [[...twenty, 'one too many'], ['x'.repeat(WORK_LIMITS.criterion + 1)], [''], ['   \n\t'], [3], [null], [['nested']], 'one string', {}, null])
    assert.throws(() => taskCriteria(bad), code('INVALID_INPUT'), JSON.stringify(bad)?.slice(0, 40));
});

test('dependency ids are at most 50 distinct UUIDs, lowercased and ascending; plan intent is an exact revision and a trimmed key', () => {
  const [a, b] = [id(), id()].sort() as [string, string];
  assert.deepEqual(taskDependencyIds([b.toUpperCase(), a, b]), [a, b]);
  assert.deepEqual(taskDependencyIds(undefined), []);
  const fifty = Array.from({ length: WORK_LIMITS.dependencies }, id);
  assert.equal(taskDependencyIds(fifty).length, 50);
  for (const bad of [[...fifty, id()], ['not-a-uuid'], [1], 'x', null, [a, '']])
    assert.throws(() => taskDependencyIds(bad), code('INVALID_INPUT'));

  const material = id();
  assert.equal(taskPlanIntent(undefined), null);
  assert.equal(taskPlanIntent(null), null);
  assert.deepEqual(taskPlanIntent({ materialId: material.toUpperCase(), version: 3, intentKey: '  split-measurements  ' }),
    { materialId: material, version: 3, intentKey: 'split-measurements' });
  assert.equal(taskPlanIntent({ materialId: material, version: 1, intentKey: 'k'.repeat(WORK_LIMITS.intentKey) })!.intentKey.length, 120);
  for (const bad of [{ materialId: material, version: 1, intentKey: 'k'.repeat(WORK_LIMITS.intentKey + 1) }, { materialId: material, version: 1, intentKey: '  ' },
    { materialId: material, version: 0, intentKey: 'k' }, { materialId: material, version: 1.5, intentKey: 'k' }, { materialId: 'x', version: 1, intentKey: 'k' },
    { materialId: material, version: 1 }, { materialId: material, version: 1, intentKey: 'k', authority: 'grant' }, [], 'k'])
    assert.throws(() => taskPlanIntent(bad), code('INVALID_INPUT'), JSON.stringify(bad));
});

test('graph locks use one ascending, lowercase, de-duplicated project order and touch nothing else', async () => {
  const [a, b, c] = [id(), id(), id()].sort() as [string, string, string];
  const { reader, locked, calls } = graph();
  await lockProjectGraphs(reader, [c.toUpperCase(), a, c, b, a.toUpperCase()]);
  assert.deepEqual(locked, [[a, b, c]]);
  await lockProjectGraphs(reader, []);
  assert.equal(locked.length, 1, 'no projects, no lock call');
  assert.equal(calls.length, 0);
  await assert.rejects(lockProjectGraphs(reader, ['nope']), code('INVALID_INPUT'));
  assert.deepEqual(sortedIds([b, a.toUpperCase(), b], 'ids'), [a, b]);
});

test('the prerequisite reader returns direct, distinct, ascending ids and a result over the bound is a visible TASK_GRAPH_LIMIT', async () => {
  const [t1, t2, p1, p2, p3] = Array.from({ length: 5 }, id).sort() as [string, string, string, string, string];
  const { reader, calls } = graph({ [t1]: [p3, p1], [t2]: [p1, p2], [p1]: [p3] });
  assert.deepEqual(await directPrerequisiteIds(reader, id(), [t2, t1, t1.toUpperCase()]), [p1, p2, p3].sort(), 'no transitive closure, p1 -> p3 is not returned for p1');
  assert.deepEqual(calls.at(-1), [t1, t2].sort(), 'normalized input');
  assert.deepEqual(await directPrerequisiteIds(reader, id(), []), []);
  // A result larger than the bound is never truncated.
  const wide = graph({ [t1]: Array.from({ length: 6 }, id) });
  await assert.rejects(directPrerequisiteIds(wide.reader, id(), [t1], 5), code('TASK_GRAPH_LIMIT'));
  assert.equal((await directPrerequisiteIds(wide.reader, id(), [t1], 6)).length, 6);
  await assert.rejects(directPrerequisiteIds(wide.reader, id(), Array.from({ length: 6 }, id), 5), code('TASK_GRAPH_LIMIT'), 'the input is bounded too');
  assert.equal(TASK_GRAPH_LIMIT, 1000);
});

test('cycles: self, direct, indirect and long chains are refused; the walk stops at the proposed task and respects the safety limit', async () => {
  const [a, b, c, d, e] = Array.from({ length: 5 }, id);
  const w = id();
  // a depends on b, b on c: a -> b -> c. Making c wait on a closes a cycle; d is unrelated.
  const g = graph({ [a!]: [b!], [b!]: [c!], [c!]: [], [d!]: [] });
  await assert.rejects(assertNoDependencyCycle(g.reader, w, a!, [a!]), code('TASK_SELF_DEPENDENCY'));
  await assert.rejects(assertNoDependencyCycle(g.reader, w, b!, [a!]), code('TASK_DEPENDENCY_CYCLE'), 'b waiting on a, which waits on b');
  await assert.rejects(assertNoDependencyCycle(g.reader, w, c!, [a!]), code('TASK_DEPENDENCY_CYCLE'), 'c waiting on a, which waits on b and c');
  await assertNoDependencyCycle(g.reader, w, d!, [a!, b!, c!]);
  await assertNoDependencyCycle(g.reader, w, e!, [a!]);
  await assertNoDependencyCycle(g.reader, w, a!, []);
  await assertNoDependencyCycle(g.reader, w, a!, [c!]);

  // It stops as soon as the proposed task is reached: a hit near the start of a long chain reads few levels.
  const links = 300;
  const chain = Array.from({ length: links }, id);
  const long = graph(Object.fromEntries(chain.map((task, index) => [task, index + 1 < links ? [chain[index + 1]!] : []])));
  const head = chain[0]!; const tail = chain.at(-1)!; const nearHead = chain[2]!;
  await assert.rejects(assertNoDependencyCycle(long.reader, w, nearHead, [head]), code('TASK_DEPENDENCY_CYCLE'));
  assert.ok(long.calls.length <= 3, `walked ${long.calls.length} levels to reach a task two steps away`);
  long.calls.length = 0;
  await assert.rejects(assertNoDependencyCycle(long.reader, w, tail, [head]), code('TASK_DEPENDENCY_CYCLE'), 'the head already waits on the tail, so the tail cannot wait on it');
  assert.equal(long.calls.length, links - 1);
  long.calls.length = 0;
  await assertNoDependencyCycle(long.reader, w, e!, [head]);
  assert.equal(long.calls.length, links, 'an acyclic proposal walks the whole reachable chain exactly once');

  // The visited-task bound is explicit: a reachable graph over it is TASK_GRAPH_LIMIT, never accepted unchecked.
  await assert.rejects(assertNoDependencyCycle(long.reader, w, e!, [head], links - 1), code('TASK_GRAPH_LIMIT'));
  await assertNoDependencyCycle(long.reader, w, e!, [head], links);
  await assert.rejects(assertNoDependencyCycle(long.reader, w, e!, chain.slice(0, 11), 10), code('TASK_GRAPH_LIMIT'), 'the proposed set alone can exceed it');
  // A wide fan-out is bounded the same way.
  const fan = Array.from({ length: 40 }, id);
  const wide = graph({ [fan[0]!]: fan.slice(1) });
  await assert.rejects(assertNoDependencyCycle(wide.reader, w, e!, [fan[0]!], 20), code('TASK_GRAPH_LIMIT'));
  // A diamond is visited once per task.
  const [top, left, right, bottom] = Array.from({ length: 4 }, id);
  const diamond = graph({ [top!]: [left!, right!], [left!]: [bottom!], [right!]: [bottom!], [bottom!]: [] });
  await assertNoDependencyCycle(diamond.reader, w, e!, [top!]);
  assert.equal(diamond.calls.length, 3);
  await assert.rejects(assertNoDependencyCycle(diamond.reader, w, bottom!, [top!]), code('TASK_DEPENDENCY_CYCLE'));
});

test('a task may start only when every direct prerequisite exists, is done and is not parked', async () => {
  const w = id(); const task = id();
  const [done, open, blocked, progress, dropped, parked, missing] = Array.from({ length: 7 }, id);
  const states = { [done!]: { status: 'done' as const }, [open!]: { status: 'open' as const }, [blocked!]: { status: 'blocked' as const },
    [progress!]: { status: 'in_progress' as const }, [dropped!]: { status: 'not_pursued' as const }, [parked!]: { status: 'done' as const, parked: true } };
  await assertPrerequisitesMet(graph({ [task]: [] }).reader, w, task);
  await assertPrerequisitesMet(graph({ [task]: [done!] }, states).reader, w, task);
  for (const [name, prerequisite] of Object.entries({ open, blocked, progress, dropped, parked, missing })) {
    await assert.rejects(assertPrerequisitesMet(graph({ [task]: [done!, prerequisite!] }, states).reader, w, task), (error: unknown) =>
      error instanceof DomainError && error.code === 'TASK_PREREQUISITES_UNMET' && error.status === 409
      && JSON.stringify(error.details).includes(prerequisite!), name);
  }
  await assert.rejects(assertPrerequisitesMet(graph({}).reader, w, task), code('WORK_NOT_FOUND'));
  assert.deepEqual(unmetPrerequisites([{ id: done!, status: 'done', parked: false }, { id: parked!, status: 'done', parked: true }, { id: missing!, status: null, parked: false }]).map((item) => item.id), [parked, missing]);
  assert.deepEqual([...ELIGIBLE_STATUSES].sort(), ['done', 'in_progress']);
});

test('a plan intent returns the same task only for the same canonical creation of an unchanged task', () => {
  const taskId = id();
  const stored = { taskId, fingerprint: 'a'.repeat(64), taskVersion: 1 };
  assert.deepEqual(decidePlanIntent(null, stored.fingerprint, null), { kind: 'create' });
  assert.deepEqual(decidePlanIntent(stored, stored.fingerprint, { version: 1 }), { kind: 'replay', taskId });
  assert.throws(() => decidePlanIntent(stored, 'b'.repeat(64), { version: 1 }), code('TASK_INTENT_CONFLICT'));
  assert.throws(() => decidePlanIntent(stored, stored.fingerprint, { version: 2 }), code('TASK_INTENT_STALE'));
  assert.throws(() => decidePlanIntent(stored, stored.fingerprint, null), code('TASK_INTENT_STALE'));
  assert.throws(() => decidePlanIntent(stored, 'b'.repeat(64), { version: 2 }), code('TASK_INTENT_CONFLICT'), 'a different payload is the caller error even when the task was edited');
});

test('the creation fingerprint is canonical: sets are order-free, criteria order and every field count, retry identity does not', () => {
  const [d1, d2] = [id(), id()];
  const message = { type: 'message' as const, id: id() };
  const material = { type: 'material' as const, id: id(), version: 2 };
  const base = { title: 'Measure', outcome: 'A table', status: 'open' as WorkStatus, blocker: null, owner: null as null,
    sources: [message, material], related: [], criteria: ['one', 'two'], dependencyIds: [d1, d2] };
  const fingerprint = creationFingerprint(base);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(creationFingerprint({ ...base, sources: [material, message], dependencyIds: [d2, d1] }), fingerprint);
  for (const changed of [{ title: 'Measure again' }, { outcome: '' }, { status: 'blocked' as WorkStatus }, { blocker: 'x' }, { owner: { kind: 'human' as const, id: 'u' } },
    { sources: [message] }, { related: [message] }, { criteria: ['two', 'one'] }, { criteria: ['one'] }, { dependencyIds: [d1] }])
    assert.notEqual(creationFingerprint({ ...base, ...changed }), fingerprint, JSON.stringify(changed));
});
