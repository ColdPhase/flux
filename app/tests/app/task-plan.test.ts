import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import { agentExecutionUseCases, DomainError, type Principal } from '@flux/core';
import type { Agent, AgentConnection, AgentStandingGrant, Decision, Material, Page, WorkItem, WorkResult } from '@flux/contracts';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { agentExecutionInTransaction } from '../../apps/server/src/agent-connection/execution.js';
import { lockProjectTaskGraphs, requireTaskPrerequisitesMet, taskPrerequisiteIds } from '../../apps/server/src/work/task-graph.js';
import { nativeWorkInTransaction, workUseCases } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { backendPid, settled, waitUntilBlockedBy } from './support/locks.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// Native task criteria, prerequisites and plan intent (#152): API/persistence behavior against the real
// database. Pure rules are in task-graph-core.test.ts; the migration is in task-plan-migration.test.ts.

type Body = Record<string, unknown>;
interface ApiFailure { code: string; error: string; [key: string]: unknown }
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const ifMatch = (item: { version: number }) => ({ 'if-match': `"${item.version}"` });

async function scene() {
  const [owner, writer, viewer, outsider] = await Promise.all(['plan-owner', 'plan-writer', 'plan-viewer', 'plan-outsider'].map(person));
  const ws = await workspace(owner, 'Plan workspace');
  for (const other of [writer, viewer, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Plan project', 'restricted');
  const elsewhere = await project(owner, ws.id, 'Another project', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, viewer, 'viewer');
  await grant(owner, elsewhere.id, writer, 'contributor');
  const tasks = `/api/v1/projects/${place.id}/work`;
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Measurement plan', body: 'Step one. Step two.' } }), 201) as Material;
  const create = async (who: Person, body: Body, status = 201, path = tasks) => expectStatus(await who.browser.request('POST', path, { body }), status) as WorkItem;
  const fails = async (who: Person, body: Body, status: number, expected: string, path = tasks) => {
    const failure = expectStatus(await who.browser.request('POST', path, { body }), status) as ApiFailure;
    assert.equal(failure.code, expected, JSON.stringify(failure));
    return failure;
  };
  const patch = async (who: Person, item: { id: string; version: number }, body: Body, status = 200) =>
    expectStatus(await who.browser.request('PATCH', `/api/v1/work/${item.id}`, { body, headers: ifMatch(item) }), status);
  const patchFails = async (who: Person, item: { id: string; version: number }, body: Body, status: number, expected: string) => {
    const failure = await patch(who, item, body, status) as ApiFailure;
    assert.equal(failure.code, expected, JSON.stringify(failure));
    return failure;
  };
  const read = async (id: string) => expectStatus(await owner.browser.request('GET', `/api/v1/work/${id}`), 200) as WorkItem;
  const counts = async (projectId = place.id) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_work_items WHERE project_id=$1) AS work,
    (SELECT count(*)::int FROM project_task_notices WHERE project_id=$1) AS notices,
    (SELECT count(*)::int FROM project_task_dependencies WHERE project_id=$1) AS edges,
    (SELECT count(*)::int FROM project_task_plan_intents WHERE project_id=$1) AS intents,
    (SELECT count(*)::int FROM events WHERE object_id=$1 AND kind='project.work_created.v1') AS created,
    (SELECT count(*)::int FROM events WHERE object_id=$1 AND kind='project.work_updated.v1') AS updated`, [projectId])).rows[0] as
    { work: number; notices: number; edges: number; intents: number; created: number; updated: number };
  return { owner, writer, viewer, outsider, ws, place, elsewhere, tasks, material, create, fails, patch, patchFails, read, counts };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const intentOf = (f: Scene, key = 'decompose-measurements', version = f.material.version) => ({ materialId: f.material.materialId, version, intentKey: key });

test('tasks carry bounded criteria, same-project prerequisites and an immutable plan intent; earlier tasks present absence', async () => {
  const f = await scene();
  const legacy = await f.create(f.owner, { title: 'A task from before plans' });
  assert.deepEqual([legacy.criteria, legacy.dependencyIds, legacy.prerequisites, legacy.planIntent], [[], [], [], null]);
  const first = await f.create(f.owner, { title: 'Order the sensor' });
  const second = await f.create(f.owner, { title: 'Calibrate the sensor', status: 'done' });
  const planned = await f.create(f.writer, { title: 'Measure at 5 lux', outcome: 'A table of detections', criteria: ['  At least 20 gestures ', 'Photograph the setup', 'At least 20 gestures'],
    dependencyIds: [second.id.toUpperCase(), first.id], planIntent: { ...intentOf(f), intentKey: '  decompose-measurements ' } });
  assert.deepEqual(planned.criteria, ['At least 20 gestures', 'Photograph the setup']);
  assert.deepEqual(planned.dependencyIds, [first.id, second.id].sort());
  assert.deepEqual(planned.prerequisites.map((item) => [item.id, item.title, item.status, item.parked, item.met]).sort(),
    [[first.id, 'Order the sensor', 'open', false, false], [second.id, 'Calibrate the sensor', 'done', false, true]].sort());
  assert.deepEqual(planned.planIntent, intentOf(f));
  assert.equal(planned.createdBy.id, f.writer.id);
  assert.equal(planned.status, 'open');
  assert.deepEqual(await f.read(planned.id), planned);
  const listed = expectStatus(await f.viewer.browser.request('GET', `${f.tasks}?limit=100`), 200) as Page<WorkItem>;
  assert.deepEqual(listed.items.find((item) => item.id === planned.id), planned, 'a viewer reads the same plan fields');
  assert.deepEqual(listed.items.find((item) => item.id === legacy.id), legacy);
  const stored = (await pool.query('SELECT * FROM project_task_plan_intents WHERE task_id=$1', [planned.id])).rows[0];
  assert.deepEqual([stored.project_id, stored.material_id, stored.material_version, stored.intent_key, stored.task_version],
    [f.place.id, f.material.materialId, f.material.version, 'decompose-measurements', 1]);
  assert.match(stored.creation_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_dependencies WHERE task_id=$1', [planned.id])).rows[0].n, 2);

  // Bounds and shape fail before any write.
  const before = await f.counts();
  const bad: Body[] = [{ criteria: Array.from({ length: 21 }, (_, index) => `c${index}`) }, { criteria: ['x'.repeat(1001)] }, { criteria: [''] }, { criteria: ['   '] },
    { dependencyIds: Array.from({ length: 51 }, () => randomUUID()) }, { dependencyIds: ['nope'] }, { dependencyIds: [first.id, 7] },
    { planIntent: { materialId: f.material.materialId, version: 1, intentKey: ' ' } }, { planIntent: { materialId: f.material.materialId, version: 1, intentKey: 'k'.repeat(121) } },
    { planIntent: { materialId: f.material.materialId, version: 0, intentKey: 'k' } }, { planIntent: { materialId: 'nope', version: 1, intentKey: 'k' } },
    { planIntent: { materialId: f.material.materialId, version: 1 } }, { planIntent: 'free text' }];
  for (const invalid of bad) {
    const response = await f.owner.browser.request('POST', f.tasks, { body: { title: 'Rejected', ...invalid } });
    assert.equal(response.status, 400, `${JSON.stringify(invalid).slice(0, 80)}: ${response.text}`);
  }
  assert.deepEqual(await f.counts(), before);

  // Prerequisites and criteria may be replaced under the version the person saw; the intent never changes.
  const replaced = await f.patch(f.owner, planned, { criteria: ['Only one'], dependencyIds: [second.id] }) as WorkItem;
  assert.deepEqual([replaced.criteria, replaced.dependencyIds, replaced.version], [['Only one'], [second.id], planned.version + 1]);
  assert.deepEqual(replaced.planIntent, planned.planIntent);
  assert.equal(replaced.createdAt, planned.createdAt);
  const cleared = await f.patch(f.owner, replaced, { criteria: [], dependencyIds: [] }) as WorkItem;
  assert.deepEqual([cleared.criteria, cleared.dependencyIds, cleared.prerequisites], [[], [], []]);
  await f.patchFails(f.owner, cleared, { planIntent: null }, 400, 'PLAN_INTENT_IMMUTABLE');
  await f.patchFails(f.owner, cleared, { planIntent: { materialId: f.material.materialId, version: 1, intentKey: 'other' }, title: 'Hidden change' }, 400, 'PLAN_INTENT_IMMUTABLE');
  assert.deepEqual(await f.read(planned.id), cleared);
  assert.equal((expectStatus(await f.owner.browser.request('PATCH', `/api/v1/work/${planned.id}`, { body: { criteria: ['No precondition'] } }), 428) as ApiFailure).code, 'PRECONDITION_REQUIRED');
  const stale = expectStatus(await f.owner.browser.request('PATCH', `/api/v1/work/${planned.id}`,
    { body: { criteria: ['Stale'], dependencyIds: [first.id] }, headers: ifMatch(planned) }), 409) as ApiFailure;
  assert.equal(stale.code, 'VERSION_CONFLICT');
  assert.deepEqual(await f.read(planned.id), cleared, 'a stale replacement changes neither criteria nor edges');
});

test('prerequisites must be real tasks of the same project: guessed, foreign, self-referencing and cyclic sets are refused without leaking', async () => {
  const f = await scene();
  const foreign = await f.create(f.owner, { title: 'Task of another project' }, 201, `/api/v1/projects/${f.elsewhere.id}/work`);
  const before = await f.counts();
  const a = await f.fails(f.owner, { title: 'Guessed', dependencyIds: [randomUUID()] }, 422, 'TASK_DEPENDENCY_NOT_FOUND');
  const b = await f.fails(f.writer, { title: 'Foreign', dependencyIds: [foreign.id] }, 422, 'TASK_DEPENDENCY_NOT_FOUND');
  assert.equal(a.error, b.error, 'a guessed and a foreign id are indistinguishable');
  assert.deepEqual(await f.counts(), before);

  const t1 = await f.create(f.owner, { title: 'A' });
  const t2 = await f.create(f.owner, { title: 'B', dependencyIds: [t1.id] });
  const t3 = await f.create(f.owner, { title: 'C', dependencyIds: [t2.id] });
  await f.patchFails(f.owner, t1, { dependencyIds: [t1.id] }, 422, 'TASK_SELF_DEPENDENCY');
  await f.patchFails(f.owner, t1, { dependencyIds: [t3.id] }, 409, 'TASK_DEPENDENCY_CYCLE');
  await f.patchFails(f.owner, t1, { dependencyIds: [t2.id] }, 409, 'TASK_DEPENDENCY_CYCLE');
  await f.patchFails(f.owner, t2, { dependencyIds: [t3.id] }, 409, 'TASK_DEPENDENCY_CYCLE');
  await f.patchFails(f.owner, t1, { dependencyIds: [foreign.id] }, 422, 'TASK_DEPENDENCY_NOT_FOUND');
  await f.patchFails(f.owner, t1, { dependencyIds: [randomUUID()] }, 422, 'TASK_DEPENDENCY_NOT_FOUND');
  assert.deepEqual((await f.read(t1.id)).dependencyIds, []);
  assert.equal((await f.read(t1.id)).version, t1.version, 'refused changes bump nothing');
  // A longer acyclic reshuffle is fine, and removing the edge opens the other direction.
  const unlinked = await f.patch(f.owner, t2, { dependencyIds: [] }) as WorkItem;
  const reversed = await f.patch(f.owner, t1, { dependencyIds: [t3.id] }) as WorkItem;
  assert.deepEqual(reversed.dependencyIds, [t3.id]);
  await f.patchFails(f.owner, unlinked, { dependencyIds: [t1.id] }, 409, 'TASK_DEPENDENCY_CYCLE');
});

test('starting or finishing a task needs every prerequisite done and unparked; an active task keeps that, and results cannot bypass it', async () => {
  const f = await scene();
  const prerequisite = await f.create(f.owner, { title: 'Prerequisite' });
  const task = await f.create(f.owner, { title: 'Dependent', dependencyIds: [prerequisite.id] });
  const before = await f.counts();
  const blockedStart = await f.patchFails(f.owner, task, { status: 'in_progress' }, 409, 'TASK_PREREQUISITES_UNMET');
  assert.deepEqual(blockedStart.prerequisites, [{ id: prerequisite.id, status: 'open', parked: false }]);
  await f.patchFails(f.owner, task, { status: 'done' }, 409, 'TASK_PREREQUISITES_UNMET');
  assert.deepEqual(await f.read(task.id), task, 'a refused transition changes nothing, not even the version');
  // Other changes stay possible while a prerequisite is open, including blocked and not pursued.
  const edited = await f.patch(f.owner, task, { title: 'Dependent, renamed', status: 'blocked', blocker: 'Waiting for the sensor' }) as WorkItem;
  assert.equal(edited.status, 'blocked');
  // Creating an already started task with an open prerequisite rolls back the task, edges and notice.
  await f.fails(f.owner, { title: 'Started too early', status: 'in_progress', dependencyIds: [prerequisite.id] }, 409, 'TASK_PREREQUISITES_UNMET');
  assert.deepEqual(await f.counts(), { ...before, work: before.work, notices: before.notices, updated: before.updated + 1 });

  // Every non-done state keeps it unmet: in progress, blocked, not pursued, and a parked done task.
  for (const status of ['in_progress', 'blocked', 'not_pursued'] as const) {
    const current = await f.read(prerequisite.id);
    await f.patch(f.owner, current, { status, ...(status === 'blocked' ? { blocker: 'x' } : {}) });
    await f.patchFails(f.owner, await f.read(task.id), { status: 'in_progress' }, 409, 'TASK_PREREQUISITES_UNMET');
  }
  const done = await f.patch(f.owner, await f.read(prerequisite.id), { status: 'done' }) as WorkItem;
  const started = await f.patch(f.owner, await f.read(task.id), { status: 'in_progress' }) as WorkItem;
  assert.equal(started.status, 'in_progress');
  assert.equal(started.prerequisites[0]!.met, true);

  // An active task keeps eligibility while its prerequisites are replaced.
  const open = await f.create(f.owner, { title: 'Newly added and open' });
  await f.patchFails(f.owner, started, { dependencyIds: [prerequisite.id, open.id] }, 409, 'TASK_PREREQUISITES_UNMET');
  const another = await f.create(f.owner, { title: 'Another finished one', status: 'done' });
  const replaced = await f.patch(f.owner, started, { dependencyIds: [another.id, done.id] }) as WorkItem;
  assert.deepEqual(replaced.dependencyIds, [another.id, done.id].sort());
  const finished = await f.patch(f.owner, replaced, { status: 'done' }) as WorkItem;
  assert.equal(finished.status, 'done');
  await f.patchFails(f.owner, finished, { dependencyIds: [open.id] }, 409, 'TASK_PREREQUISITES_UNMET');
  // An inactive task may be rewired to unmet prerequisites; reopening a task whose prerequisite regressed is refused.
  const idle = await f.create(f.owner, { title: 'Idle' });
  const rewired = await f.patch(f.owner, idle, { dependencyIds: [open.id] }) as WorkItem;
  assert.equal(rewired.status, 'open');
  const regressed = await f.patch(f.owner, await f.read(another.id), { status: 'open' }) as WorkItem;
  assert.equal(regressed.status, 'open');
  await f.patchFails(f.owner, await f.read(finished.id), { status: 'in_progress' }, 409, 'TASK_PREREQUISITES_UNMET');

  // A recorded result that finishes a task is a done transition too.
  const gated = await f.create(f.owner, { title: 'Finished by a result', dependencyIds: [open.id] });
  const resultsBefore = (await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.place.id])).rows[0].n;
  const refused = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/results`, { body: {
    title: 'A finding', finding: 'negative', work: [gated.id], finishes: { id: gated.id, expectedVersion: gated.version } } }), 409) as ApiFailure;
  assert.equal(refused.code, 'TASK_PREREQUISITES_UNMET');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.place.id])).rows[0].n, resultsBefore, 'no result is left behind');
  assert.equal((await f.read(gated.id)).status, 'open');
  await f.patch(f.owner, await f.read(open.id), { status: 'done' });
  const accepted = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/results`, { body: {
    title: 'A finding', finding: 'positive', work: [gated.id], finishes: { id: gated.id, expectedVersion: gated.version } } }), 201) as WorkResult;
  assert.ok(accepted.id);
  assert.equal((await f.read(gated.id)).status, 'done');
});

test('a parked prerequisite stays unmet until it is brought back and finished', async () => {
  const f = await scene();
  const prerequisite = await f.create(f.owner, { title: 'Will be parked' });
  const dependent = await f.create(f.owner, { title: 'Waits for it', dependencyIds: [prerequisite.id] });
  const decide = async (body: Body, expectedStatus = 201) => expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/decisions`, { body }), expectedStatus) as Decision;
  const accept = async (decision: Decision, body: Body = {}) => expectStatus(await f.owner.browser.request('POST', `/api/v1/decisions/${decision.id}/accept`,
    { body, headers: ifMatch(decision) }), 200) as Decision;
  const rule = await accept(await decide({ title: 'Use the camera' }));
  await accept(await decide({ title: 'Use a time-of-flight sensor instead', supersedes: rule.id }), { park: [prerequisite.id] });
  const parked = await f.read(prerequisite.id);
  assert.ok(parked.parked, 'the pivot parked it without changing its status');
  assert.equal((await f.read(dependent.id)).prerequisites[0]!.parked, true);
  await f.patchFails(f.owner, dependent, { status: 'in_progress' }, 409, 'TASK_PREREQUISITES_UNMET');
  const back = await f.patch(f.owner, parked, { parked: false }) as WorkItem;
  assert.equal(back.parked, null);
  const done = await f.patch(f.owner, back, { status: 'done' }) as WorkItem;
  assert.equal(done.status, 'done');
  assert.equal((await f.patch(f.owner, dependent, { status: 'in_progress' }) as WorkItem).status, 'in_progress');
  // A done task that is parked (older pivots) is not met either: the check reads the parked state, not the status alone.
  const rule2 = await accept(await decide({ title: 'Back to the camera', supersedes: (await decide({ title: 'Interim' }).then(accept)).id }));
  assert.ok(rule2.id);
});

test('the same canonical plan intent returns the original task once; other payloads, edited tasks and moved plans conflict visibly', async () => {
  const f = await scene();
  const first = await f.create(f.owner, { title: 'Prepare the rig' });
  const creation = { title: 'Measure at 5 lux', outcome: 'A table', criteria: ['20 gestures', 'Photograph'], dependencyIds: [first.id], planIntent: intentOf(f) };
  const created = await f.create(f.owner, { ...creation, clientCommandId: randomUUID() });
  const baseline = await f.counts();
  assert.deepEqual([baseline.created, baseline.notices, baseline.intents], [2, 2, 1]);

  // A retry, another command identity, another actor and a re-ordered but identical creation are the same task.
  const retry = await f.create(f.writer, { ...creation, dependencyIds: [first.id.toUpperCase()], criteria: ['20 gestures', ' Photograph '], clientCommandId: randomUUID() });
  assert.deepEqual(retry, created, 'same id, creator, times and version');
  assert.deepEqual(await f.create(f.owner, { ...creation }), created, 'no client command identity needed');
  assert.deepEqual(await f.counts(), baseline, 'no second task, notice, edge, intent or event');

  // A different canonical creation for the same intent is a conflict, never another task or an overwrite.
  for (const changed of [{ title: 'Measure at 10 lux' }, { criteria: ['20 gestures'] }, { criteria: ['Photograph', '20 gestures'] }, { dependencyIds: [] }, { outcome: '' }, { status: 'blocked' }]) {
    const conflict = await f.fails(f.owner, { ...creation, ...changed }, 409, 'TASK_INTENT_CONFLICT');
    assert.equal(conflict.taskId, created.id);
  }
  assert.deepEqual(await f.counts(), baseline);
  assert.deepEqual(await f.read(created.id), created);

  // Another key, or the same key in another revision, is a different intent.
  const another = await f.create(f.owner, { ...creation, planIntent: intentOf(f, 'second-split') });
  assert.notEqual(another.id, created.id);
  assert.equal((await f.counts()).intents, 2);

  // The plan moves on: the old revision conflicts before any old outcome is returned; the new one is a new intent.
  const next = expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${f.material.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Step one. Step two. Step three.' } }), 200) as Material;
  assert.equal(next.version, 2);
  const moved = await f.fails(f.owner, creation, 409, 'SOURCE_VERSION_CONFLICT');
  assert.deepEqual([moved.requestedVersion, moved.currentVersion], [1, 2]);
  await f.fails(f.owner, { ...creation, clientCommandId: randomUUID() }, 409, 'SOURCE_VERSION_CONFLICT');
  await f.fails(f.owner, { ...creation, title: 'Different', planIntent: intentOf(f, creation.planIntent.intentKey, 3) }, 409, 'SOURCE_VERSION_CONFLICT');
  const nextRevision = await f.create(f.owner, { ...creation, planIntent: intentOf(f, creation.planIntent.intentKey, 2) });
  assert.notEqual(nextRevision.id, created.id);
  assert.deepEqual(nextRevision.planIntent, { materialId: f.material.materialId, version: 2, intentKey: creation.planIntent.intentKey });
  assert.deepEqual((await f.read(created.id)).planIntent, creation.planIntent, 'the first task keeps its original revision');

  // An edited produced task is stale, whoever edited it; so is a changed payload on top of that.
  const edited = await f.patch(f.owner, await f.read(another.id), { title: 'Measure at 5 lux, renamed by a person' }) as WorkItem;
  const secondCreation = { ...creation, planIntent: intentOf(f, 'second-split', 2) };
  const secondTask = await f.create(f.owner, secondCreation);
  await f.patch(f.writer, secondTask, { outcome: 'Edited' });
  const stale = await f.fails(f.owner, secondCreation, 409, 'TASK_INTENT_STALE');
  assert.equal(stale.taskId, secondTask.id);
  await f.fails(f.owner, { ...secondCreation, title: 'Different' }, 409, 'TASK_INTENT_CONFLICT');
  assert.equal(edited.title, 'Measure at 5 lux, renamed by a person');

  // A plan from another project, or one that does not exist, is not a source.
  const otherPlan = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.elsewhere.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Not this project', body: 'x' } }), 201) as Material;
  const absent = await f.fails(f.owner, { title: 'No such plan', planIntent: { materialId: otherPlan.materialId, version: 1, intentKey: 'k' } }, 422, 'PLAN_SOURCE_NOT_FOUND');
  const guessed = await f.fails(f.owner, { title: 'No such plan', planIntent: { materialId: randomUUID(), version: 1, intentKey: 'k' } }, 422, 'PLAN_SOURCE_NOT_FOUND');
  assert.equal(absent.error, guessed.error);
});

test('creation retries keep the stored shape for older commands and cover every plan field for new ones', async () => {
  const f = await scene();
  const commandId = randomUUID();
  const legacyBody = { title: 'Legacy shape', outcome: 'x', clientCommandId: commandId };
  const created = await f.create(f.owner, legacyBody);
  // A creation without plan fields is fingerprinted exactly as before this feature, so older retries still match.
  const old = createHash('sha256').update(JSON.stringify({ title: 'Legacy shape', outcome: 'x', status: 'open', blocker: null, owner: null, sources: [], related: [] })).digest('hex');
  assert.equal((await pool.query('SELECT request_fingerprint FROM project_work_items WHERE id=$1', [created.id])).rows[0].request_fingerprint, old);
  assert.deepEqual(await f.create(f.owner, legacyBody), created);
  await f.fails(f.owner, { ...legacyBody, criteria: ['Now with a criterion'] }, 409, 'IDEMPOTENCY_CONFLICT');
  const dependency = await f.create(f.owner, { title: 'Prerequisite' });
  await f.fails(f.owner, { ...legacyBody, dependencyIds: [dependency.id] }, 409, 'IDEMPOTENCY_CONFLICT');
  await f.fails(f.owner, { ...legacyBody, planIntent: intentOf(f) }, 409, 'IDEMPOTENCY_CONFLICT');
  const planned = { title: 'With a plan', clientCommandId: randomUUID(), criteria: ['One'], dependencyIds: [dependency.id], planIntent: intentOf(f) };
  const first = await f.create(f.owner, planned);
  assert.deepEqual(await f.create(f.owner, planned), first);
  await f.fails(f.owner, { ...planned, criteria: ['One', 'Two'] }, 409, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await f.create(f.writer, planned), first, 'another actor with the same creation reaches the same task through its intent');
});

test('concurrent planners creating one intent produce exactly one task, notice, edge set and event', async () => {
  const f = await scene();
  const prerequisite = await f.create(f.owner, { title: 'Shared prerequisite' });
  const before = await f.counts();
  const creation = { title: 'Decomposed once', criteria: ['A', 'B'], dependencyIds: [prerequisite.id], planIntent: intentOf(f, 'race') };
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? f.writer : f.owner).browser.request('POST', f.tasks,
    { body: { ...creation, clientCommandId: randomUUID() } })));
  for (const response of results) assert.equal(response.status, 201, response.text);
  const ids = new Set(results.map((response) => (response.json as WorkItem).id));
  assert.equal(ids.size, 1);
  const task = await f.read([...ids][0]!);
  for (const response of results) assert.deepEqual(response.json, task);
  const after = await f.counts();
  assert.deepEqual({ ...after }, { ...before, work: before.work + 1, notices: before.notices + 1, edges: before.edges + 1, intents: before.intents + 1, created: before.created + 1 });

  // Different payloads racing for one intent: one wins, every other planner conflicts, and there is one task.
  const racing = await Promise.all(Array.from({ length: 6 }, (_, index) => f.owner.browser.request('POST', f.tasks,
    { body: { title: `Competing decomposition ${index}`, planIntent: intentOf(f, 'competing') } })));
  assert.deepEqual(racing.map((response) => response.status).sort(), [201, 409, 409, 409, 409, 409]);
  for (const response of racing.filter((item) => item.status === 409)) assert.equal((response.json as ApiFailure).code, 'TASK_INTENT_CONFLICT');
  assert.equal((await f.counts()).intents, after.intents + 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND title LIKE 'Competing decomposition %'", [f.place.id])).rows[0].n, 1);
});

test('opposite-order dependency writers never deadlock and reciprocal edges leave exactly one direction', async () => {
  const f = await scene();
  const actor = { kind: 'human' as const, id: f.owner.id } as Principal;
  const work = workUseCases(db);
  for (let round = 0; round < 8; round++) {
    const [a, b] = await Promise.all([work.createWork(actor, f.place.id, { title: `A${round}` }), work.createWork(actor, f.place.id, { title: `B${round}` })]);
    const outcomes = await Promise.allSettled([work.updateWork(actor, a.id, { dependencyIds: [b.id] }, a.version), work.updateWork(actor, b.id, { dependencyIds: [a.id] }, b.version)]);
    const ok = outcomes.filter((item) => item.status === 'fulfilled').length;
    assert.equal(ok, 1, `round ${round}: ${outcomes.map((item) => item.status === 'rejected' ? (item.reason as Error).message : 'ok').join(' | ')}`);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(code('TASK_DEPENDENCY_CYCLE')(outcome.reason), `${(outcome.reason as Error).message}`);
    const edges = (await pool.query('SELECT task_id, prerequisite_id FROM project_task_dependencies WHERE task_id = ANY($1)', [[a.id, b.id]])).rows;
    assert.equal(edges.length, 1);
  }
  // A ring of three reciprocal writers whose task sets only partly overlap: the first two edges win, the last one closes the ring.
  for (let round = 0; round < 6; round++) {
    const [x, y, z] = await Promise.all(['X', 'Y', 'Z'].map((title) => work.createWork(actor, f.place.id, { title: `${title}${round}` })));
    const ring = await Promise.allSettled([work.updateWork(actor, x!.id, { dependencyIds: [y!.id] }, x!.version),
      work.updateWork(actor, y!.id, { dependencyIds: [z!.id] }, y!.version), work.updateWork(actor, z!.id, { dependencyIds: [x!.id] }, z!.version)]);
    assert.equal(ring.filter((item) => item.status === 'fulfilled').length, 2, `ring ${round}: ${ring.map((item) => item.status === 'rejected' ? (item.reason as Error).message : 'ok').join(' | ')}`);
    for (const outcome of ring) if (outcome.status === 'rejected') assert.ok(code('TASK_DEPENDENCY_CYCLE')(outcome.reason), (outcome.reason as Error).message);
  }
  // Overlapping prerequisite sets in opposite listing order, mixed with starts, finishes and creations.
  const base = await Promise.all(Array.from({ length: 5 }, (_, index) => work.createWork(actor, f.place.id, { title: `Base ${index}` })));
  const ids = base.map((item) => item.id);
  const operations: Promise<unknown>[] = [];
  for (let index = 0; index < 12; index++) {
    const order = index % 2 ? [...ids].reverse() : ids;
    operations.push(work.createWork(actor, f.place.id, { title: `Dependent ${index}`, dependencyIds: order, planIntent: index % 3 ? undefined : intentOf(f, `overlap-${index % 2}`) }).catch((error) => {
      if (!(error instanceof DomainError)) throw error;
    }));
    operations.push((async () => {
      const current = await work.getWork(actor, ids[index % 5]!);
      return work.updateWork(actor, current.id, { status: index % 2 ? 'done' : 'in_progress', dependencyIds: ids.filter((other) => other !== current.id && (index + ids.indexOf(other)) % 2 === 0).reverse() }, current.version);
    })().catch((error) => { if (!(error instanceof DomainError)) throw error; }));
  }
  await Promise.all(operations);
});

test('graph locks are one advisory lock per project in ascending, lowercase, de-duplicated order and lock nothing else', async () => {
  const f = await scene();
  const [p1, p2] = [f.place.id, f.elsewhere.id].sort() as [string, string];
  const key = (projectId: string) => `flux.task-graph:${projectId}`;
  await db.transaction(async (tx) => {
    // Record the lock statements the primitive runs, in order.
    const issued: string[] = [];
    const recording = new Proxy(tx, { get(target, property) {
      if (property === 'execute') return (query: { queryChunks?: unknown[] }) => {
        for (const chunk of query.queryChunks ?? []) if (typeof chunk === 'string') issued.push(chunk);
        return Reflect.apply(target.execute, target, [query]);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof tx;
    await lockProjectTaskGraphs(recording, [p2.toUpperCase(), p1, p2, p1.toUpperCase()]);
    assert.deepEqual(issued, [key(p1), key(p2)], 'ascending, lowercase, de-duplicated; exactly one lock statement each');
    // The advisory objects held are exactly hashtextextended('flux.task-graph:' || project, 0), and no row, tuple or transaction lock.
    const pid = await backendPid(tx);
    const rows = (await pool.query(`SELECT locktype, classid::text AS classid, objid::text AS objid FROM pg_locks WHERE pid=$1 AND locktype <> 'virtualxid'
      AND NOT (locktype = 'relation' AND mode = 'AccessShareLock')`, [pid])).rows;
    const expected = (await pool.query(`SELECT ((h >> 32) & 4294967295)::bigint::text AS classid, (h & 4294967295)::bigint::text AS objid
      FROM (SELECT hashtextextended($1, 0) AS h UNION ALL SELECT hashtextextended($2, 0)) keys`, [key(p1), key(p2)])).rows;
    assert.deepEqual(rows.map((row) => row.locktype), ['advisory', 'advisory'], JSON.stringify(rows));
    assert.deepEqual(rows.map((row) => [row.classid, row.objid]).sort(), expected.map((row) => [row.classid, row.objid]).sort());
  });
  await db.transaction(async (tx) => {
    await lockProjectTaskGraphs(tx, []);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory'`, [await backendPid(tx)])).rows[0].n, 0);
    await assert.rejects(lockProjectTaskGraphs(tx, ['not-a-project']), code('INVALID_INPUT'));
  });
  // Two transactions locking the same projects in different listing orders cannot deadlock: both take the ascending order.
  const holders = await Promise.all([0, 1, 2, 3].map((index) => db.transaction(async (tx) => {
    await lockProjectTaskGraphs(tx, index % 2 ? [p2, p1] : [p1, p2]);
    return index;
  })));
  assert.deepEqual(holders, [0, 1, 2, 3]);
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/**
 * Runs `run` in a transaction that keeps everything it locked until `release()`. `pid` is returned only after `run`
 * has taken its locks, so a competitor started afterwards is the one that waits. A failing `run` rejects instead of hanging.
 */
async function holding(run: (tx: Tx) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (value: { pid: number; tx: Tx }) => void; let failed!: (error: unknown) => void;
  const locked = new Promise<{ pid: number; tx: Tx }>((resolve, reject) => { ready = resolve; failed = reject; });
  const finished = db.transaction(async (tx) => { const pid = await backendPid(tx); await run(tx); ready({ pid, tx }); await released; })
    .catch((error: unknown) => { failed(error); throw error; });
  finished.catch(() => undefined);
  return { ...(await locked), release, finished };
}

test('claim-versus-writer lock waits use the exported primitives in the pinned order', async () => {
  const f = await scene();
  const actor = { kind: 'human' as const, id: f.owner.id } as Principal;
  const work = workUseCases(db);
  const [x, y] = await Promise.all([work.createWork(actor, f.place.id, { title: 'X' }), work.createWork(actor, f.place.id, { title: 'Y', status: 'done' })]);
  const unit = await work.createWork(actor, f.place.id, { title: 'Claimed unit', dependencyIds: [x.id] });
  const ws = f.ws.id;

  // A claim holds the graph lock, then its tasks and their prerequisites, while a plan writer waits for the graph lock first.
  const claim = await holding(async (tx) => {
    await lockProjectTaskGraphs(tx, [f.place.id]);
    const prerequisites = await taskPrerequisiteIds(tx, ws, [unit.id]);
    assert.deepEqual(prerequisites, [x.id]);
    const wanted = [unit.id, ...prerequisites].sort();
    const locked = await tx.execute(sql`SELECT id FROM project_work_items WHERE id IN (${sql.join(wanted.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id FOR UPDATE`);
    assert.equal(locked.rows.length, 2);
    await assert.rejects(requireTaskPrerequisitesMet(tx, ws, unit.id), code('TASK_PREREQUISITES_UNMET'));
  });
  try {
    const writing = work.updateWork(actor, unit.id, { dependencyIds: [y.id] }, unit.version);
    const done = settled(writing);
    await waitUntilBlockedBy(pool, claim.pid);
    assert.equal(done(), false, 'the writer waits for the claim');
    // The writer is waiting, so the dependency set the claim discovered is still the current one.
    assert.deepEqual(await taskPrerequisiteIds(claim.tx, ws, [unit.id]), [x.id]);
    claim.release();
    await claim.finished;
    assert.deepEqual((await writing).dependencyIds, [y.id]);
  } finally { claim.release(); }

  // The graph lock alone serializes writers: a holder with no task rows still makes a writer of unrelated tasks wait.
  const [p, q] = await Promise.all([work.createWork(actor, f.place.id, { title: 'P' }), work.createWork(actor, f.place.id, { title: 'Q' })]);
  const elsewhereBase = await work.createWork(actor, f.elsewhere.id, { title: 'Elsewhere base' });
  const graphOnly = await holding((tx) => lockProjectTaskGraphs(tx, [f.place.id]));
  try {
    const unrelated = work.updateWork(actor, p.id, { dependencyIds: [q.id] }, p.version);
    const unrelatedDone = settled(unrelated);
    await waitUntilBlockedBy(pool, graphOnly.pid);
    assert.equal(unrelatedDone(), false, 'a graph writer waits for the project graph lock even when no task row is shared');
    // Another project has its own graph lock.
    assert.deepEqual((await work.createWork(actor, f.elsewhere.id, { title: 'Elsewhere', dependencyIds: [elsewhereBase.id] })).dependencyIds, [elsewhereBase.id]);
    graphOnly.release();
    await graphOnly.finished;
    assert.deepEqual((await unrelated).dependencyIds, [q.id]);
  } finally { graphOnly.release(); }

  // A writer holds the graph and task locks; a claim waits for the graph lock and then sees the committed set.
  let session!: ReturnType<typeof nativeWorkInTransaction>;
  const writer = await holding(async (tx) => {
    session = nativeWorkInTransaction(tx);
    const current = await session.getWork(actor, unit.id);
    await session.updateWork(actor, unit.id, { dependencyIds: [x.id, y.id] }, current.version);
  });
  try {
    const claimer = db.transaction(async (tx) => {
      await lockProjectTaskGraphs(tx, [f.place.id]);
      return taskPrerequisiteIds(tx, ws, [unit.id]);
    });
    const claimed = settled(claimer);
    await waitUntilBlockedBy(pool, writer.pid);
    assert.equal(claimed(), false, 'the claim waits for the writer');
    await session.flushEvents();
    writer.release();
    await writer.finished;
    assert.deepEqual(await claimer, [x.id, y.id].sort());
  } finally { writer.release(); }
});

test('the reader is direct, distinct, ascending, lock-free and bounded; the start check reads current rows and fails closed', async () => {
  const f = await scene();
  const actor = { kind: 'human' as const, id: f.owner.id } as Principal;
  const work = workUseCases(db);
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((title) => work.createWork(actor, f.place.id, { title })));
  const d = await work.createWork(actor, f.place.id, { title: 'D', dependencyIds: [b.id, c.id] });
  const e = await work.createWork(actor, f.place.id, { title: 'E', dependencyIds: [c.id, a.id] });
  const g = await work.createWork(actor, f.place.id, { title: 'G', dependencyIds: [d.id] });
  await db.transaction(async (tx) => {
    assert.deepEqual(await taskPrerequisiteIds(tx, f.ws.id, [e.id, d.id.toUpperCase(), d.id]), [a.id, b.id, c.id].sort(), 'distinct, ascending, lowercase');
    assert.deepEqual(await taskPrerequisiteIds(tx, f.ws.id, [g.id]), [d.id], 'direct prerequisites only, no closure');
    assert.deepEqual(await taskPrerequisiteIds(tx, f.ws.id, [a.id]), []);
    assert.deepEqual(await taskPrerequisiteIds(tx, f.ws.id, []), []);
    assert.deepEqual(await taskPrerequisiteIds(tx, randomUUID(), [e.id]), [], 'another workspace sees none');
    await assert.rejects(taskPrerequisiteIds(tx, f.ws.id, ['nope']), code('INVALID_INPUT'));
    await assert.rejects(requireTaskPrerequisitesMet(tx, f.ws.id, randomUUID()), code('WORK_NOT_FOUND'));
    await requireTaskPrerequisitesMet(tx, f.ws.id, a.id);
    await assert.rejects(requireTaskPrerequisitesMet(tx, f.ws.id, g.id), code('TASK_PREREQUISITES_UNMET'));
    // Neither reader acquired an advisory, row, tuple or transaction lock.
    const locks = (await tx.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND (locktype IN ('advisory','transactionid','tuple','page') OR mode IN ('RowShareLock','RowExclusiveLock'))`)).rows[0] as { n: number };
    assert.equal(locks.n, 0, 'reading locks nothing');
  });

  // Missing and foreign prerequisite rows (impossible through the foreign keys) count as unmet, not as done.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const orphan = randomUUID();
    await client.query('INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id) VALUES ($1,$2,$3,$4)', [f.ws.id, f.place.id, a.id, orphan]);
    const foreign = await work.createWork(actor, f.elsewhere.id, { title: 'In another project', status: 'done' });
    await client.query('INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id) VALUES ($1,$2,$3,$4)', [f.ws.id, f.place.id, a.id, foreign.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  await db.transaction(async (tx) => {
    await assert.rejects(requireTaskPrerequisitesMet(tx, f.ws.id, a.id), (error: unknown) => {
      const details = (error as DomainError).details as { prerequisites: { id: string; status: unknown }[] };
      return code('TASK_PREREQUISITES_UNMET')(error) && details.prerequisites.length === 2 && details.prerequisites.every((item) => item.status === null);
    });
  });
  await pool.query('DELETE FROM project_task_dependencies WHERE task_id=$1', [a.id]);
});

test('the graph reader and the cycle walk are bounded by TASK_GRAPH_LIMIT instead of accepting a partial graph', async () => {
  const f = await scene();
  const actor = { kind: 'human' as const, id: f.owner.id } as Principal;
  const work = workUseCases(db);
  const insertTasks = async (count: number, prefix: string) => (await pool.query(
    `INSERT INTO project_work_items (id, workspace_id, project_id, title, created_by_kind, created_by_id)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::text || n, 'human', $4::text FROM generate_series(1, $5::int) AS n RETURNING id`,
    [f.ws.id, f.place.id, prefix, f.owner.id, count])).rows.map((row: { id: string }) => row.id).sort();
  // 21 tasks with 50 distinct prerequisites each: 1,050 distinct direct prerequisites is over the bound; 20 tasks is exactly at it.
  const dependents = await insertTasks(21, 'wide-');
  const prerequisites = await insertTasks(1050, 'leaf-');
  await pool.query(`INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id)
    SELECT $1::uuid, $2::uuid, ($3::uuid[])[(n - 1) / 50 + 1], ($4::uuid[])[n] FROM generate_series(1, 1050) AS n`, [f.ws.id, f.place.id, dependents, prerequisites]);
  await db.transaction(async (tx) => {
    assert.equal((await taskPrerequisiteIds(tx, f.ws.id, dependents.slice(0, 20))).length, 1000);
    await assert.rejects(taskPrerequisiteIds(tx, f.ws.id, dependents), code('TASK_GRAPH_LIMIT'));
    await assert.rejects(taskPrerequisiteIds(tx, f.ws.id, [...dependents, ...prerequisites]), code('TASK_GRAPH_LIMIT'));
  });

  // A chain of 1,001 tasks reaches more than the cycle walk may visit; a chain of 1,000 does not.
  const chain = await insertTasks(1001, 'chain-');
  const order = chain;
  await pool.query(`INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id)
    SELECT $1::uuid, $2::uuid, ($3::uuid[])[n], ($3::uuid[])[n + 1] FROM generate_series(1, 1000) AS n`, [f.ws.id, f.place.id, order]);
  const head = await work.createWork(actor, f.place.id, { title: 'Wants the whole chain' });
  const tooLong = work.updateWork(actor, head.id, { dependencyIds: [order[0]!] }, head.version);
  await assert.rejects(tooLong, code('TASK_GRAPH_LIMIT'));
  assert.deepEqual((await work.getWork(actor, head.id)).dependencyIds, [], 'nothing is accepted unchecked');
  await pool.query('DELETE FROM project_task_dependencies WHERE task_id=$1', [order[999]]);
  const fits = await work.updateWork(actor, head.id, { dependencyIds: [order[0]!] }, head.version);
  assert.deepEqual(fits.dependencyIds, [order[0]]);
  // And the long chain still detects a cycle through its far end.
  await assert.rejects(work.updateWork(actor, order[999]!, { dependencyIds: [order[0]!] }, 1), code('TASK_DEPENDENCY_CYCLE'));
});

test('permissions: only people and agents who can write the project plan tasks; foreign ids and closed access reveal nothing', async () => {
  const f = await scene();
  const prerequisite = await f.create(f.owner, { title: 'Open to readers' });
  const planned = await f.create(f.owner, { title: 'Planned', criteria: ['Visible'], dependencyIds: [prerequisite.id], planIntent: intentOf(f, 'permissions') });
  const body = { title: 'Not allowed', criteria: ['x'], dependencyIds: [prerequisite.id] };
  assert.equal((expectStatus(await f.viewer.browser.request('POST', f.tasks, { body }), 403) as ApiFailure).code, 'FORBIDDEN');
  expectStatus(await f.outsider.browser.request('POST', f.tasks, { body }), 404);
  expectStatus(await f.viewer.browser.request('PATCH', `/api/v1/work/${planned.id}`, { body: { criteria: ['x'] }, headers: ifMatch(planned) }), 403);
  expectStatus(await f.outsider.browser.request('PATCH', `/api/v1/work/${planned.id}`, { body: { dependencyIds: [] }, headers: ifMatch(planned) }), 404);
  expectStatus(await f.outsider.browser.request('GET', `/api/v1/work/${planned.id}`), 404);
  assert.deepEqual(await f.read(planned.id), planned);
  assert.deepEqual((expectStatus(await f.viewer.browser.request('GET', `/api/v1/work/${planned.id}`), 200) as WorkItem).criteria, ['Visible']);
  // A contributor whose access is later removed can no longer plan.
  const writerGrant = (await pool.query('SELECT id FROM project_grants WHERE project_id=$1 AND user_id=$2', [f.place.id, f.writer.id])).rows[0].id;
  expectStatus(await f.owner.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${writerGrant}`), 204);
  assert.notEqual((await f.writer.browser.request('POST', f.tasks, { body })).status, 201);
  // A genuine agent with a contributor grant plans through the same command; without one it cannot.
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, { body: { name: 'Planner agent', owner: 'self' } }), 201) as Agent;
  const agentActor = { kind: 'agent' as const, id: agent.id } as Principal;
  await assert.rejects(workUseCases(db).createWork(agentActor, f.place.id, { title: 'Agent plan', dependencyIds: [prerequisite.id] }), (error: unknown) => error instanceof DomainError && error.status === 404);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const byAgent = await workUseCases(db).createWork(agentActor, f.place.id, { title: 'Agent plan', criteria: ['Agent criterion'], dependencyIds: [prerequisite.id], planIntent: intentOf(f, 'agent-plan') });
  assert.deepEqual([byAgent.createdBy.kind, byAgent.createdBy.id, byAgent.criteria, byAgent.dependencyIds], ['agent', agent.id, ['Agent criterion'], [prerequisite.id]]);
});

/** Records the order of every domain/policy statement and event insertion of one transaction, including the receipt port's. */
function ordered(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const log: { op: string; table?: unknown }[] = [];
  const proxy = new Proxy(tx, { get(target, property) {
    if (['select', 'selectDistinct', 'update', 'delete', 'execute', 'insert'].includes(String(property)))
      return (...args: unknown[]) => { log.push({ op: String(property), table: args[0] }); return Reflect.apply(Reflect.get(target, property), target, args); };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as typeof tx;
  return { tx: proxy, log };
}

async function execution(f: Scene, maximumUses = 3) {
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, { body: { name: 'Execution planner', owner: 'self' } }), 201) as Agent;
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expectStatus(await f.owner.browser.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id, selectedProjectIds: [f.place.id],
    scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201) as AgentConnection;
  const clientId = `plan-fixture-${randomUUID()}`; const bindingId = randomUUID();
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)', [randomUUID(), clientId, 'Plan fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)', [bindingId, f.owner.id, connection.id, clientId]);
  const claims = { ownerUserId: f.owner.id, connectionId: connection.id, clientId, grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes };
  const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
  const standing = expectStatus(await f.owner.browser.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: {
    clientCommandId: randomUUID(), projectId: f.place.id, operation: 'work.create', peerRequestClass: 'execute', maximumUses, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
  return { agent, connection, claims, runtime, standing };
}

test('a standing-grant execution creates criteria, edges, intent, task, notice, debit and receipt in one unit before the single final flush', async () => {
  const f = await scene();
  const x = await execution(f);
  const prerequisite = await f.create(f.owner, { title: 'Prerequisite for the agent plan', status: 'done' });
  const payload = { title: 'Agent decomposition', criteria: ['Reproducible'], dependencyIds: [prerequisite.id], planIntent: intentOf(f, 'agent-unit') };
  const command = (clientCommandId = randomUUID()) => ({ runtimeSessionId: x.runtime.id, grantId: x.standing.id, clientCommandId, projectId: f.place.id, operation: 'work.create' as const,
    peerRequestClass: 'execute' as const, audience: { kind: 'project' as const, projectId: f.place.id }, objectId: null,
    sources: [{ materialId: f.material.materialId, version: f.material.version }], payload });
  const rows = async () => ({ ...(await f.counts()),
    receipts: (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [x.connection.id])).rows[0].n as number,
    used: (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [x.standing.id])).rows[0].used as number });
  const run = async (input: ReturnType<typeof command>, phase?: 'before-flush' | 'after-flush') => db.transaction(async (raw) => {
    const { tx, log } = ordered(raw);
    const native = nativeWorkInTransaction(tx);
    const principal = { kind: 'agent' as const, id: x.agent.id } as Principal;
    const result = await agentExecutionUseCases(agentExecutionInTransaction(tx, x.claims)).run(input, async (scope) => {
      if (scope.replay) return { value: scope.replay.value, postconditions: scope.replay.postconditions };
      const task = await native.createWork(principal, f.place.id, payload);
      return { value: { workId: task.id, version: task.version }, postconditions: [{ kind: 'work' as const, id: task.id, version: task.version }] };
    });
    if (phase === 'before-flush') throw new Error('injected failure after receipt, before the final flush');
    const events = await native.flushEvents();
    // Every domain, edge, intent, notice, debit and receipt write precedes the first event; only events and audience follow.
    const first = log.findIndex((entry) => entry.op === 'insert' && entry.table === schema.events);
    if (events.length) {
      assert.ok(first > 0);
      const before = log.slice(0, first);
      for (const table of [schema.projectWorkItems, schema.projectTaskDependencies, schema.projectTaskPlanIntents, schema.projectTaskNotices, schema.agentCommandReceipts])
        assert.ok(before.some((entry) => entry.op === 'insert' && entry.table === table), 'an insert into a native table precedes the first event');
      assert.ok(before.some((entry) => entry.op === 'update' && entry.table === schema.agentStandingGrants), 'the debit precedes the first event');
      for (const entry of log.slice(first)) assert.ok(entry.op === 'insert' && (entry.table === schema.events || entry.table === schema.eventAudience), `only final events follow: ${entry.op}`);
    } else assert.equal(first, -1, 'no event is inserted at all');
    if (phase === 'after-flush') throw new Error('injected failure after the final flush');
    return { result, events, intents: native.eventIntents };
  });

  const start = await rows();
  const original = command();
  for (const phase of ['before-flush', 'after-flush'] as const) {
    await assert.rejects(run(original, phase), /injected failure/);
    assert.deepEqual(await rows(), start, `${phase}: task, notice, edges, intent, events, receipt and debit all roll back`);
  }
  const committed = await run(original);
  const task = await f.read((committed.result as { workId: string }).workId);
  assert.deepEqual([task.criteria, task.dependencyIds, task.planIntent, task.createdBy.id], [['Reproducible'], [prerequisite.id], intentOf(f, 'agent-unit'), x.agent.id]);
  assert.equal(committed.events.length, 1);
  const created = await rows();
  assert.deepEqual(created, { ...start, work: start.work + 1, notices: start.notices + 1, edges: start.edges + 1, intents: start.intents + 1, created: start.created + 1, receipts: 1, used: 1 });

  // The same plan intent through another command identity returns the original task and emits no creation event or notice.
  const again = await run(command());
  assert.equal((again.result as { workId: string }).workId, task.id);
  assert.deepEqual(again.events, []);
  assert.deepEqual(await rows(), { ...created, receipts: 2, used: 2 }, 'a new command debits and records its receipt, but adds no task, notice, edge, intent or event');
  assert.deepEqual(await f.read(task.id), task);
  // The original command identity replays its stored receipt without a second effect, event or debit.
  const replayed = await run(original);
  assert.deepEqual([replayed.result, replayed.events], [committed.result, []]);
  assert.deepEqual(await rows(), { ...created, receipts: 2, used: 2 });
});

test('database rules: composite foreign keys, no self edge, one edge per pair, bounded criteria and immutable intents', async () => {
  const f = await scene();
  const [a, b] = await Promise.all([f.create(f.owner, { title: 'A' }), f.create(f.owner, { title: 'B' })]);
  const foreign = await f.create(f.owner, { title: 'Foreign' }, 201, `/api/v1/projects/${f.elsewhere.id}/work`);
  const planned = await f.create(f.owner, { title: 'Planned', planIntent: intentOf(f, 'db-rules') });
  const client = await pool.connect();
  const fails = async (query: string, values: unknown[], expected: { code: string; constraint?: string }) => {
    await client.query('SAVEPOINT attempt');
    try { await client.query(query, values); } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      const failure = error as { code?: string; constraint?: string; message?: string };
      assert.equal(failure.code, expected.code, `${query}: ${failure.message}`);
      if (expected.constraint) assert.equal(failure.constraint, expected.constraint);
      return;
    }
    throw new Error(`accepted: ${query} ${JSON.stringify(values)}`);
  };
  const edge = 'INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id) VALUES ($1,$2,$3,$4)';
  try {
    await client.query('BEGIN');
    await fails(edge, [f.ws.id, f.place.id, a.id, a.id], { code: '23514', constraint: 'project_task_dependency_not_self' });
    await fails(edge, [f.ws.id, f.place.id, a.id, foreign.id], { code: '23503' });
    await fails(edge, [f.ws.id, f.elsewhere.id, a.id, b.id], { code: '23503' });
    await fails(edge, [randomUUID(), f.place.id, a.id, b.id], { code: '23503' });
    await fails(edge, [f.ws.id, f.place.id, a.id, randomUUID()], { code: '23503' });
    await client.query(edge, [f.ws.id, f.place.id, a.id, b.id]);
    await fails(edge, [f.ws.id, f.place.id, a.id, b.id], { code: '23505', constraint: 'project_task_dependencies_pkey' });
    // At most 50 prerequisites per task, even for a writer that skips the command.
    const many = (await client.query(`INSERT INTO project_work_items (id, workspace_id, project_id, title, created_by_kind, created_by_id)
      SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'many-' || n, 'human', $3::text FROM generate_series(1, 51) AS n RETURNING id`, [f.ws.id, f.place.id, f.owner.id])).rows.map((row: { id: string }) => row.id);
    for (const id of many.slice(0, 50)) await client.query(edge, [f.ws.id, f.place.id, b.id, id]);
    await fails(edge, [f.ws.id, f.place.id, b.id, many[50]], { code: '23514' });

    const setCriteria = 'UPDATE project_work_items SET criteria = $2::jsonb WHERE id = $1';
    await client.query(setCriteria, [a.id, JSON.stringify(Array.from({ length: 20 }, (_, index) => `c${index}`))]);
    for (const invalid of [Array.from({ length: 21 }, (_, index) => `c${index}`), ['same', 'same'], [' padded'], ['padded '], [''], ['x'.repeat(1001)], [1], [{ text: 'object' }], { not: 'an array' }, 'text', null])
      await fails(setCriteria, [a.id, JSON.stringify(invalid)], { code: '23514', constraint: 'project_work_criteria_bounded' });
    await client.query(setCriteria, [a.id, JSON.stringify(['x'.repeat(1000), 'line one\nline two'])]);

    const intent = `INSERT INTO project_task_plan_intents (workspace_id, project_id, material_id, material_version, intent_key, task_id, creation_fingerprint, task_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`;
    const fingerprint = 'a'.repeat(64);
    await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 1, 'db-rules', a.id, fingerprint], { code: '23505', constraint: 'project_task_plan_intents_pkey' });
    await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 1, 'another', planned.id, fingerprint], { code: '23505' });
    await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 2, 'future-revision', a.id, fingerprint], { code: '23503' });
    await fails(intent, [f.ws.id, f.elsewhere.id, f.material.materialId, 1, 'other-project', a.id, fingerprint], { code: '23503' });
    await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 1, 'foreign-task', foreign.id, fingerprint], { code: '23503' });
    for (const key of ['', ' padded', 'k'.repeat(121)]) await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 1, key, b.id, fingerprint], { code: '23514' });
    await fails(intent, [f.ws.id, f.place.id, f.material.materialId, 1, 'bad-fingerprint', b.id, 'not a hash'], { code: '23514' });
    await client.query(intent, [f.ws.id, f.place.id, f.material.materialId, 1, 'k'.repeat(120), b.id, fingerprint]);
    await fails('UPDATE project_task_plan_intents SET intent_key = $1 WHERE task_id = $2', ['rewritten', planned.id], { code: '23514' });
    await fails('UPDATE project_task_plan_intents SET task_version = 9 WHERE task_id = $1', [planned.id], { code: '23514' });
    await fails('DELETE FROM project_work_items WHERE id = $1', [planned.id], { code: '23503' });
    await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }

  // Removing the whole project removes its edges and intents with it (and nothing else fails).
  const doomed = await project(f.owner, f.ws.id, 'Doomed project', 'restricted');
  const plan = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${doomed.id}/materials`, { body: { clientMutationId: randomUUID(), title: 'Doomed plan', body: 'x' } }), 201) as Material;
  const base = await f.create(f.owner, { title: 'Doomed base' }, 201, `/api/v1/projects/${doomed.id}/work`);
  await f.create(f.owner, { title: 'Doomed planned', dependencyIds: [base.id], criteria: ['c'], planIntent: { materialId: plan.materialId, version: 1, intentKey: 'k' } }, 201, `/api/v1/projects/${doomed.id}/work`);
  const remover = await pool.connect();
  try {
    await remover.query('BEGIN');
    await remover.query('DELETE FROM projects WHERE id=$1', [doomed.id]);
    for (const table of ['project_task_dependencies', 'project_task_plan_intents', 'project_work_items'])
      assert.equal((await remover.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`, [doomed.id])).rows[0].n, 0, table);
    await remover.query('ROLLBACK');
  } finally { remover.release(); }
});
