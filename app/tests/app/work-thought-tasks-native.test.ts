import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { createBoundedWorkReads, DomainError, type WorkReadUnitOfWork } from '@flux/core';
import type { CreatedThought, Sketch, WorkItem, WorkThoughtTasks } from '@flux/contracts';
import { nativeWorkReadFinalFence, nativeWorkReadUnitOfWork } from '../../apps/server/src/work-read/adapters.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createSessionResolver } from '../../apps/server/src/identity/session.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { inBatches } from './support/batches.js';

// #170/#196: tasks linked to selected project thoughts, without the project work collection.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
after(() => pool.end());
const sessions = createSessionResolver(createAuth({ db, config: loadIdentityConfig(), mailer: null, oauthRequests: createOauthRequests() }));

describe('tasks linked to selected thoughts with exact counts, one bounded window and current fences', () => {
  let owner: Person, viewer: Person, outsider: Person;
  let workspaceId: string, projectId: string, otherId: string;
  let dark: string, camera: string, quiet: string, privateThought: string, foreignThought: string;
  const tasks: Record<string, WorkItem> = {};
  const post = async <T>(who: Person, path: string, body: unknown) => expectStatus(await who.browser.request('POST', path,
    { body, headers: { 'idempotency-key': randomUUID() } }), 201) as T;
  const path = (ids: string, id = projectId) => `/api/v1/projects/${id}/work-thought-tasks?thoughtIds=${ids}`;
  const read = async (ids: string[], who = owner, id = projectId) => {
    const response = await who.browser.request('GET', path(ids.join(','), id));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return expectStatus(response, 200) as WorkThoughtTasks;
  };
  const sketch = (title: string, scope: 'project' | 'private', id?: string) => post<Sketch>(owner, `/api/v1/workspaces/${workspaceId}/sketches`, { title, scope, ...(id ? { projectId: id } : {}) });
  const thought = async (sketchId: string, text: string) => (await post<CreatedThought>(owner, `/api/v1/sketches/${sketchId}/thoughts`, { text, x: 0, y: 0 })).thought.id;
  const ref = (id: string) => ({ type: 'thought', id });
  const createWork = (title: string, fields: Record<string, unknown> = {}, id = projectId) => post<WorkItem>(owner, `/api/v1/projects/${id}/work`, { title, ...fields });
  const heldRead = async (who: Person, id: string, ids: string[], mutate: () => Promise<unknown>) => {
    const headers = { cookie: who.browser.cookieHeader() }, initial = await sessions.requirePrincipal({ headers });
    const native = nativeWorkReadUnitOfWork(db);
    const held: WorkReadUnitOfWork = { run: async (run) => { const value = await native.run(run); await mutate(); return value; } };
    return createBoundedWorkReads(held, nativeWorkReadFinalFence(db, sessions, initial, headers))
      .thoughtTasks(initial.principal, id, new URLSearchParams({ thoughtIds: ids.join(',') }));
  };

  before(async () => {
    [owner, viewer, outsider] = await Promise.all(['thought-owner', 'thought-viewer', 'thought-outsider'].map(person));
    workspaceId = (await workspace(owner, 'Thought task counts')).id;
    await addMember(owner, workspaceId, viewer, 'member');
    projectId = (await project(owner, workspaceId, 'Thought scope', 'restricted')).id;
    otherId = (await project(owner, workspaceId, 'Other thought scope', 'restricted')).id;
    await grant(owner, projectId, viewer, 'viewer');
    const map = (await sketch('Sensing directions', 'project', projectId)).id;
    [dark, camera, quiet] = [await thought(map, 'Dark room'), await thought(map, 'Camera only'), await thought(map, 'Nobody home')];
    privateThought = await thought((await sketch('Private notes', 'private')).id, 'Private thought');
    foreignThought = await thought((await sketch('Other map', 'project', otherId)).id, 'Other project thought');
    tasks.order = await createWork('Order sensors', { sources: [ref(dark)], status: 'in_progress', owner: { kind: 'human', id: viewer.id } });
    tasks.calibrate = await createWork('Calibrate', { sources: [ref(dark), ref(camera)], status: 'blocked', blocker: 'delivery' });
    tasks.protocol = await createWork('Protocol', { related: [ref(dark)] });
    tasks.done = await createWork('Finished earlier', { sources: [ref(dark)], status: 'done' });
    tasks.foreign = await createWork('Foreign title must not escape', { sources: [ref(foreignThought)] }, otherId);
  });

  test('counts, many-to-many pairs, chooser order and who added each task; foreign thoughts are indistinguishable', async () => {
    const missing = randomUUID();
    const observed = await read([quiet, camera, dark, privateThought, foreignThought, missing, dark], viewer);
    assert.equal(observed.projectId, projectId); assert.equal(observed.access, 'viewer'); assert.match(observed.observedAt, /\.\d{6}Z$/);
    assert.deepEqual(observed.counts, [{ thoughtId: dark, tasks: 4 }, { thoughtId: camera, tasks: 1 }].sort((a, b) => a.thoughtId < b.thoughtId ? -1 : 1));
    assert.equal(observed.linkTotal, 5);
    const forDark = observed.links.filter((link) => link.thoughtId === dark).map((link) => link.workId);
    assert.deepEqual(forDark, [tasks.order!.id, tasks.calibrate!.id, tasks.protocol!.id, tasks.done!.id], 'in progress, blocked, open, done');
    assert.deepEqual(observed.links.filter((link) => link.thoughtId === camera).map((link) => link.workId), [tasks.calibrate!.id]);
    assert.equal(observed.items.length, 4, 'a task under two thoughts is one row');
    const calibrate = observed.items.find((item) => item.id === tasks.calibrate!.id)!;
    assert.deepEqual(calibrate.createdBy, { kind: 'human', id: owner.id, name: 'thought-owner' });
    assert.equal(calibrate.status, 'blocked'); assert.equal(calibrate.blocker, 'delivery');
    assert.deepEqual(observed.items.find((item) => item.id === tasks.order!.id)!.owner, { kind: 'human', id: viewer.id, name: 'thought-viewer' });
    for (const item of observed.items) for (const forbidden of ['links', 'outcome', 'criteria', 'planIntent']) assert.equal(forbidden in item, false);
    const text = JSON.stringify(observed);
    for (const hidden of [privateThought, foreignThought, missing, otherId, tasks.foreign!.title]) assert.equal(text.includes(hidden), false);
    // A thought without tasks, a private one, a foreign one and a random id read the same.
    const none = [quiet, privateThought, foreignThought, missing].map((id) => read([id]));
    for (const value of await Promise.all(none)) { assert.deepEqual([value.counts, value.links, value.linkTotal, value.items], [[], [], 0, []]); }
  });

  test('raw 100 bound, closed query and current project access', async () => {
    assert.equal((await read(Array(100).fill(dark))).counts.length, 1, 'duplicates count toward the raw bound and are then merged');
    for (const ids of ['', 'bad', `${dark},`, Array(101).fill(dark).join(','), `work:${dark}`]) expectStatus(await owner.browser.request('GET', path(ids)), 400);
    for (const extra of ['&limit=1', '&cursor=abc', `&thoughtIds=${dark}`, '&objects=x']) expectStatus(await owner.browser.request('GET', path(dark) + extra), 400);
    expectStatus(await owner.browser.request('GET', `/api/v1/projects/${projectId}/work-thought-tasks`), 400);
    expectStatus(await outsider.browser.request('GET', path(dark)), 404);
    expectStatus(await viewer.browser.request('GET', path(foreignThought, otherId)), 404);
    await grant(owner, projectId, viewer, 'denied');
    try { expectStatus(await viewer.browser.request('GET', path(dark)), 404); } finally { await grant(owner, projectId, viewer, 'viewer'); }
  });

  test('one global window of 100 pairs with exact totals; the rest is counted, never listed', async () => {
    const isolated = (await project(owner, workspaceId, 'Thought scale', 'restricted')).id;
    const big = (await sketch('Scale map', 'project', isolated)).id;
    const [one, two] = [await thought(big, 'Many tasks'), await thought(big, 'One more')];
    const made = await inBatches(103, (i) => createWork(`Scale task ${i}`, { sources: [ref(one)] }, isolated));
    await createWork('Under the second thought', { sources: [ref(two)] }, isolated);
    const observed = await read([one, two], owner, isolated);
    assert.deepEqual(new Map(observed.counts.map((entry) => [entry.thoughtId, entry.tasks])), new Map([[one, 103], [two, 1]]));
    assert.equal(observed.linkTotal, 104); assert.equal(observed.links.length, 100); assert.equal(observed.items.length, 100);
    const first = one < two ? one : two;
    assert.ok(observed.links.every((link, i) => i === 0 || observed.links[i - 1]!.thoughtId <= link.thoughtId), 'ordered by thought');
    assert.equal(observed.links[0]!.thoughtId, first);
    const single = await read([one], owner, isolated);
    assert.equal(single.links.length, 100); assert.ok(single.links.every((link) => made.some((task) => task.id === link.workId)));
  });

  test('a thought that changes or a new link during the observation is refused, not released', async () => {
    const isolated = (await project(owner, workspaceId, 'Thought drift', 'restricted')).id;
    const map = (await sketch('Drift map', 'project', isolated)).id;
    const [kept, removed] = [await thought(map, 'Kept'), await thought(map, 'Removed')];
    const task = await createWork('Linked later', {}, isolated);
    const reject = (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === 'work_read_changed';
    await assert.rejects(heldRead(owner, isolated, [kept, removed], () => pool.query('DELETE FROM sketch_thoughts WHERE id=$1', [removed])), reject);
    await assert.rejects(heldRead(owner, isolated, [kept], () => post(owner, `/api/v1/projects/${isolated}/links`,
      { from: { type: 'work', id: task.id }, to: { type: 'thought', id: kept }, role: 'related' })), reject);
    const fresh = await read([kept, removed], owner, isolated);
    assert.deepEqual(fresh.counts, [{ thoughtId: kept, tasks: 1 }]);
  });
});
