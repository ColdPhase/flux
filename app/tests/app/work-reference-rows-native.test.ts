import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, sql } from '@flux/db';
import { createBoundedWorkReads, DomainError, type WorkReadUnitOfWork } from '@flux/core';
import type { Agent, Decision, WorkItem, WorkReferenceRows, WorkResult } from '@flux/contracts';
import { nativeWorkReadFinalFence, nativeWorkReadUnitOfWork } from '../../apps/server/src/work-read/adapters.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createSessionResolver } from '../../apps/server/src/identity/session.js';
import { addMember, expectStatus, grant, person, project, secondSession, workspace, type Person } from './support/people.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
after(() => pool.end());
const sessions = createSessionResolver(createAuth({ db, config: loadIdentityConfig(), mailer: null, oauthRequests: createOauthRequests() }));
const key = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;

describe('selected native reference rows with exact sessions and current membership fences', () => {
  let owner: Person, writer: Person, viewer: Person, outsider: Person;
  let workspaceId: string, projectId: string, foreignId: string;
  let work: WorkItem, foreign: WorkItem, decision: Decision, result: WorkResult;
  const post = async <T>(who: Person, path: string, body: unknown) => expectStatus(await who.browser.request('POST', path,
    { body, headers: { 'idempotency-key': randomUUID() } }), 201) as T;
  const path = (objects: string, id = projectId) => `/api/v1/projects/${id}/work-reference-rows?objects=${objects}`;
  const read = async (objects: string, who = owner, id = projectId) => {
    const response = await who.browser.request('GET', path(objects, id));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return expectStatus(response, 200) as WorkReferenceRows;
  };
  const createWork = (title: string, id = projectId, fields = {}) => post<WorkItem>(owner, `/api/v1/projects/${id}/work`, { title, ...fields });
  const heldRead = async (who: Person, id: string, objects: string, mutate: () => Promise<unknown>) => {
    const headers = { cookie: who.browser.cookieHeader() }, initial = await sessions.requirePrincipal({ headers });
    const native = nativeWorkReadUnitOfWork(db);
    const held: WorkReadUnitOfWork = { run: async (read) => { const value = await native.run(read); await mutate(); return value; } };
    return createBoundedWorkReads(held, nativeWorkReadFinalFence(db, sessions, initial, headers))
      .references(initial.principal, id, new URLSearchParams({ objects }));
  };

  before(async () => {
    [owner, writer, viewer, outsider] = await Promise.all(['reference-owner', 'reference-writer', 'reference-viewer', 'reference-outsider'].map(person));
    workspaceId = (await workspace(owner, 'Selected reference observations')).id;
    for (const who of [writer, viewer]) await addMember(owner, workspaceId, who, 'member');
    projectId = (await project(owner, workspaceId, 'Exact reference scope', 'restricted')).id;
    foreignId = (await project(owner, workspaceId, 'Other reference scope', 'restricted')).id;
    await grant(owner, projectId, writer, 'contributor'); await grant(owner, projectId, viewer, 'viewer');
    work = await createWork('Current native cited work', projectId, { outcome: 'Long own outcome must not escape', criteria: ['Own full criterion'], owner: { kind: 'human', id: writer.id } });
    foreign = await createWork('Foreign title must not escape', foreignId, { owner: { kind: 'human', id: owner.id } });
    decision = await post<Decision>(owner, `/api/v1/projects/${projectId}/decisions`, { title: 'Selected native decision', rationale: 'Long private-to-detail rationale' });
    result = await post<WorkResult>(owner, `/api/v1/projects/${projectId}/results`, { title: 'Selected native result', finding: 'positive', evidence: 'Long own evidence', work: [work.id] });
  });

  test('mixed historical identities isolate opaque markers and preserve exact native rows, owners and versions', async () => {
    const missing = randomUUID();
    const observation = await read(`work:${foreign.id},work:${work.id},result:${result.id},decision:${decision.id},work:${missing},work:${work.id}`, viewer);
    assert.equal(observation.projectId, projectId); assert.equal(observation.access, 'viewer'); assert.match(observation.observedAt, /\.\d{6}Z$/);
    assert.deepEqual(observation.items.map(key), [`decision:${decision.id}`, `result:${result.id}`, `work:${work.id}`]);
    assert.deepEqual(observation.unavailable, [foreign.id, missing].sort().map((id) => ({ kind: 'work', id })));
    const row = observation.items.find(({ kind }) => kind === 'work'); assert.ok(row?.kind === 'work');
    assert.deepEqual(row.owner, { kind: 'human', id: writer.id, name: 'reference-writer' }); assert.equal(row.version, work.version);
    for (const item of observation.items) for (const forbidden of ['links', 'outcome', 'criteria', 'dependencyIds', 'prerequisites', 'planIntent', 'rationale', 'evidence']) assert.equal(forbidden in item, false);
    assert.equal(JSON.stringify(observation).includes(foreign.title), false);
    assert.equal(JSON.stringify(observation).includes(foreignId), false);
    const onlyUnavailable = await read(`work:${missing},work:${foreign.id}`);
    assert.deepEqual(onlyUnavailable.items, []); assert.deepEqual(onlyUnavailable.unavailable, observation.unavailable);
    const agent = await post<Agent>(owner, `/api/v1/workspaces/${workspaceId}/agents`, { name: 'Native reference agent', owner: 'workspace' });
    await post(owner, `/api/v1/projects/${projectId}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
    const agentWork = await createWork('Actually agent-owned', projectId, { owner: { kind: 'agent', id: agent.id } });
    const agentRow = (await read(`work:${agentWork.id}`)).items[0]; assert.ok(agentRow?.kind === 'work');
    assert.deepEqual(agentRow.owner, { kind: 'agent', id: agent.id, name: agent.name });
    const changed = expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${work.id}`, { body: { title: 'Changed current native title' }, headers: { 'if-match': `"${work.version}"` } }), 200) as WorkItem;
    const updated = (await read(`work:${work.id}`)).items[0]; assert.ok(updated?.kind === 'work');
    assert.equal(updated.title, changed.title); assert.equal(updated.version, changed.version);
  });

  test('raw 100 bound and closed URL reject duplicates/extra fields before normalization', async () => {
    assert.equal((await read(Array(100).fill(`work:${work.id}`).join(','))).items.length, 1);
    const invalid = ['', 'work:bad', `work:${work.id},`, `message:${work.id}`, Array(101).fill(`work:${work.id}`).join(',')];
    for (const objects of invalid) expectStatus(await owner.browser.request('GET', path(objects)), 400);
    for (const extra of ['&limit=1', '&q=secret', '&cursor=abc', '&objects=work:'+work.id]) expectStatus(await owner.browser.request('GET', path(`work:${work.id}`)+extra), 400);
    expectStatus(await owner.browser.request('GET', `/api/v1/projects/${projectId}/work-reference-rows`), 400);
  });

  test('100 different native identities are one global bound with no project enumeration', async () => {
    const fixtures = await Promise.all(Array.from({ length: 105 }, (_, i) => createWork(`Reference scale ${i}`)));
    const selected = fixtures.slice(0, 100);
    const observation = await read(selected.map(({ id }) => `work:${id}`).join(','));
    assert.equal(observation.items.length, 100); assert.deepEqual(observation.unavailable, []);
    assert.deepEqual(observation.items.map(({ id }) => id), selected.map(({ id }) => id).sort());
    assert.ok(observation.items.every(({ id }) => !fixtures.slice(100).some((row) => row.id === id)));
    expectStatus(await owner.browser.request('GET', path(fixtures.map(({ id }) => `work:${id}`).join(','))), 400);
  });

  test('project/session denial fails the whole request while a readable downgrade updates final access', async () => {
    expectStatus(await outsider.browser.request('GET', path(`work:${work.id},work:${randomUUID()}`)), 404);
    expectStatus(await viewer.browser.request('GET', path(`work:${foreign.id}`, foreignId)), 404);
    const denied = heldRead(writer, projectId, `work:${work.id}`, () => grant(owner, projectId, writer, 'denied'));
    try { await assert.rejects(denied, { status: 404 }); } finally { await grant(owner, projectId, writer, 'contributor'); }
    try {
      const down = await heldRead(writer, projectId, `work:${work.id}`, () => grant(owner, projectId, writer, 'viewer'));
      assert.equal(down.access, 'viewer'); assert.equal(down.items.length, 1);
    } finally { await grant(owner, projectId, writer, 'contributor'); }
    for (const expired of [false, true]) {
      const current = await secondSession(writer);
      await assert.rejects(heldRead({ ...writer, browser: current.browser }, projectId, `work:${work.id}`, () => expired
        ? pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [current.sessionId])
        : pool.query('DELETE FROM auth_sessions WHERE id=$1', [current.sessionId])),
      (error: unknown) => error instanceof DomainError && error.status === 401 && error.code === 'UNAUTHENTICATED');
      assert.equal((await writer.browser.request('GET', path(`work:${work.id}`))).status, 200);
    }
  });

  test('zero-link selected found-to-marker and marker-to-found drift rejects assembled metadata', async () => {
    for (const direction of ['delete', 'foreign', 'appear'] as const) {
      const isolated = (await project(owner, workspaceId, `Reference drift ${direction}`, 'restricted')).id;
      const target = await createWork('Zero-link selected target', direction === 'appear' ? foreignId : isolated);
      const mutate = () => direction === 'delete' ? pool.query('DELETE FROM project_work_items WHERE id=$1', [target.id])
        : pool.query('UPDATE project_work_items SET project_id=$1 WHERE id=$2', [direction === 'appear' ? isolated : foreignId, target.id]);
      await assert.rejects(heldRead(owner, isolated, `work:${target.id}`, mutate),
        (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === 'work_read_changed');
      const fresh = await read(`work:${target.id}`, owner, isolated);
      assert.equal(fresh.items.length, direction === 'appear' ? 1 : 0); assert.equal(fresh.unavailable.length, direction === 'appear' ? 0 : 1);
    }
  });

  test('the existing relation/source visibility fence still rejects changed aggregates', async () => {
    const isolated = (await project(owner, workspaceId, 'Reference aggregate drift', 'restricted')).id;
    const target = await createWork('Selected target with actual new edge', isolated);
    const conversation = await post<{ messages: { id: string }[] }>(owner, `/api/v1/projects/${isolated}/conversations`, { body: 'Actual native source', clientMessageId: randomUUID() });
    await assert.rejects(heldRead(owner, isolated, `work:${target.id}`, () => post(owner, `/api/v1/projects/${isolated}/links`,
      { from: { type: 'work', id: target.id }, to: { type: 'message', id: conversation.messages[0]!.id }, role: 'source' })),
    (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === 'work_read_changed');
    assert.equal((await read(`work:${target.id}`, owner, isolated)).items[0]?.relations.sourceMessages, 1);
  });

  test('real SQL observation failure remains unavailable instead of invented missing markers', async () => {
    const headers = { cookie: owner.browser.cookieHeader() }, initial = await sessions.requirePrincipal({ headers });
    const failing: WorkReadUnitOfWork = { run: async (read) => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 / 0`);
      return nativeWorkReadUnitOfWork(db).run(read);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' }) };
    await assert.rejects(createBoundedWorkReads(failing, nativeWorkReadFinalFence(db, sessions, initial, headers))
      .references(initial.principal, projectId, new URLSearchParams({ objects: `work:${work.id},work:${randomUUID()}` })),
    (error: unknown) => error instanceof DomainError && error.status === 503 && error.code === 'WORK_READ_UNAVAILABLE');
  });
});
