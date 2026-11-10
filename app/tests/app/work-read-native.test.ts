import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, nativeWorkAssociationRows, nativeWorkVisibilityRows, sql, type NativeWorkAssociationSelector, type Transaction } from '@flux/db';
import { createBoundedWorkReads, DomainError, type WorkReadUnitOfWork } from '@flux/core';
import type { Agent, Conversation, Decision, Material, ProjectWorkSummary, ProjectWorkView, WorkAssociations, WorkDetailProjection, WorkItem, WorkRelations, WorkRowProjection } from '@flux/contracts';
import { nativeWorkReadFinalFence, nativeWorkReadUnitOfWork } from '../../apps/server/src/work-read/adapters.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createSessionResolver } from '../../apps/server/src/identity/session.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, removeFromSpace, person, project, secondSession, workspace, type Person } from './support/people.js';

// Real native commands, HTTP cookies and PostgreSQL observations. Holds wrap actual
// reads, never substitute native session/project authority with a fabricated port.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
after(() => pool.end());
const sessions = createSessionResolver(createAuth({ db, config: loadIdentityConfig(), mailer: null, oauthRequests: createOauthRequests() }));
const post = async <T>(who: Person, path: string, body: unknown, headers?: Record<string, string>) => expectStatus(await who.browser.request('POST', path, { body, headers }), 201) as T;
const code = (status: number, expected: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === expected;

describe('bounded native work reads through HTTP and current native fences', () => {
  let owner: Person, other: Person, viewer: Person, outsider: Person;
  let workspaceId: string, projectId: string;
  let conversation: Conversation, main: WorkItem, finished: WorkItem;
  let oldRule: Decision, rule: Decision, material: Material;
  let sketchId: string, thoughtId: string, zeroMessageId: string;
  const base = () => `/api/v1/projects/${projectId}`;
  const get = async <T>(path: string, who = owner) => {
    const response = await who.browser.request('GET', path);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return expectStatus(response, 200) as T;
  };
  const addWork = (title: string, fields: Record<string, unknown> = {}) => post<WorkItem>(owner, `${base()}/work`, { title, ...fields }, { 'idempotency-key': randomUUID() });

  before(async () => {
    [owner, other, viewer, outsider] = await Promise.all(['Ada', 'Ada', 'native-read-viewer', 'native-read-outsider'].map(person));
    workspaceId = (await workspace(owner, 'Bounded native read fixtures')).id;
    await addMember(owner, workspaceId, other, 'member'); await addMember(owner, workspaceId, viewer, 'member');
    projectId = (await project(owner, workspaceId, 'Native bounded projections', 'restricted')).id;
    await grant(owner, projectId, other, 'contributor'); await grant(owner, projectId, viewer, 'contributor');
    const agents = await Promise.all([0, 1].map(() => post<Agent>(owner, `/api/v1/workspaces/${workspaceId}/agents`, { name: 'Ada', owner: 'self' })));
    for (const ref of [{ kind: 'human', id: owner.id }, { kind: 'human', id: other.id }, ...agents.map(({ id }) => ({ kind: 'agent', id }))])
      await addWork(`Active ${ref.kind} ${ref.id}`, { status: 'in_progress', owner: ref });
    conversation = await post<Conversation>(owner, `${base()}/conversations`, { body: 'Actual source opening\nSecond line stays private to its body', clientMessageId: randomUUID() });
    zeroMessageId = (await post<{ id: string }>(other, `/api/v1/conversations/${conversation.id}/messages`, { body: 'Zero-link source', clientMessageId: randomUUID() })).id;
    material = await post<Material>(owner, `${base()}/materials`, { title: 'Material v1', body: 'Version one', clientMutationId: randomUUID() });
    expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`, { body: { title: 'Material v2', expectedVersion: 1, clientMutationId: randomUUID() } }), 200);
    sketchId = (await post<{ id: string }>(owner, `/api/v1/workspaces/${workspaceId}/sketches`, { title: 'Shared thought scope', scope: 'project', projectId })).id;
    thoughtId = (await post<{ thought: { id: string } }>(owner, `/api/v1/sketches/${sketchId}/thoughts`, { text: 'Actual thought opening\nOther text', x: 0, y: 0 })).thought.id;
    const message = { type: 'message', id: conversation.messages[0]!.id };
    main = await addWork('Native main work', { outcome: 'Own full outcome', sources: [message, { type: 'material', id: material.materialId, version: 1 }, { type: 'material', id: material.materialId, version: 2 }, { type: 'thought', id: thoughtId }] });
    await post(owner, `${base()}/links`, { from: { type: 'work', id: main.id }, to: message, role: 'related' });
    finished = await addWork('Finished selected work', { status: 'done' });
    const proposal = await post<Decision>(other, `${base()}/decisions`, { title: 'Earlier native rule', rationale: 'Own full rationale', affects: [main.id], sources: [message] });
    oldRule = expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${proposal.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200) as Decision;
    const pivot = await post<Decision>(other, `${base()}/decisions`, { title: 'Current native rule', supersedes: oldRule.id });
    rule = expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${pivot.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200) as Decision;
  });

  test('same-name humans and agents remain distinct bounded owners; view and summary share native observation', async () => {
    const summary = await get<ProjectWorkSummary>(`${base()}/work-summary`);
    assert.deepEqual(summary.all, { needs: 0, in_progress: 4, blocked: 0, open: 1, finished: 1, rules: 2 });
    assert.equal(summary.workTotal, 6); assert.equal(summary.unfinishedTotal, 5);
    assert.equal('state' in summary, false, 'the summary is counts only; nothing reads a project state from it (#962)');
    const first = await get<ProjectWorkView>(`${base()}/work-view?limit=3`, viewer);
    assert.equal(first.items.length, 3); assert.equal(first.total, 8); assert.equal(first.summary.access, 'contributor');
    assert.deepEqual(first.summary.all, summary.all); assert.match(first.summary.observedAt, /\.\d{6}Z$/);
    const seen = [...first.items]; let next = first.nextCursor;
    while (next) { const page = await get<ProjectWorkView>(`${base()}/work-view?limit=3&cursor=${next}`, viewer); seen.push(...page.items); next = page.nextCursor; }
    assert.equal(new Set(seen.map(({ kind, id }) => `${kind}:${id}`)).size, 8);
    assert.deepEqual(seen.filter(({ kind }) => kind === 'decision').map(({ id }) => id), [rule.id, oldRule.id]);
    for (const row of seen) for (const forbidden of ['links', 'outcome', 'rationale', 'evidence', 'createdByKind', 'ownerUserId']) assert.equal(forbidden in row, false);
    const projected = seen.find(({ id }) => id === main.id) as WorkRowProjection;
    assert.deepEqual(projected.relations, { edges: 6, sourceMessages: 1, sourceMaterials: 2, decisions: 1 });
    assert.equal(projected.rule?.id, oldRule.id);
    const mine = await get<ProjectWorkView>(`${base()}/work-view?mine=true`);
    // Mine is the person's own task and the two tasks of their own agents (#865); the other human's and the same-name rows stay out.
    assert.equal(mine.summary.mine.in_progress, 3); assert.equal(mine.summary.mine.rules, 0);
    assert.equal(mine.total, 3);
  });

  test('bounded counts follow open and finished work, dropped or not', async () => {
    const isolated = await project(owner, workspaceId, 'Native retained state', 'restricted');
    const path = `/api/v1/projects/${isolated.id}`;
    const create = (title: string, status = 'open') => post<WorkItem>(owner, `${path}/work`, { title, status });
    const openA = await create('Open A'), openB = await create('Open B');
    await create('Completed native work', 'done');
    // A task that was dropped is Done with a "dropped" note (#868); a task is created Done first, then dropped.
    const stopped = await create('Dropped native work', 'done');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${stopped.id}`, { body: { status: 'done', dropped: true }, headers: { 'if-match': `"${stopped.version}"` } }), 200);
    const original = await post<Decision>(owner, `${path}/decisions`, { title: 'Earlier direction' });
    expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${original.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200);
    const proposal = await post<Decision>(owner, `${path}/decisions`, { title: 'Actual rule', supersedes: original.id });
    expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${proposal.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200);
    const observation = await get<ProjectWorkSummary>(`${path}/work-summary`);
    assert.deepEqual([observation.all.open, observation.all.finished, observation.all.rules], [2, 2, 2]);
    // Finishing and dropping the two open tasks moves them into the finished count; nothing is left open.
    for (const [item, dropped] of [[openA, false], [openB, true]] as const)
      expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${item.id}`,
        { body: { status: 'done', ...(dropped ? { dropped } : {}) }, headers: { 'if-match': `"${item.version}"` } }), 200);
    const updated = await get<ProjectWorkSummary>(`${path}/work-summary`);
    assert.deepEqual([updated.all.open, updated.all.finished], [0, 4]);
    expectStatus(await outsider.browser.request('GET', `${path}/work-summary`), 404);
    const mixed = await get<ProjectWorkSummary>(`${base()}/work-summary`);
    assert.equal(mixed.all.rules, 2, 'accepted plus genuine superseded history are both counted');
  });

  test('bounded task plan counts preserve canonical own criteria, prerequisites and plan intent', async () => {
    const isolated = await project(owner, workspaceId, 'Bounded native task plans', 'restricted');
    const path = `/api/v1/projects/${isolated.id}`;
    const create = (title: string, fields: Record<string, unknown> = {}) => post<WorkItem>(owner, `${path}/work`, { title, ...fields });
    const ready = await create('Ready prerequisite', { status: 'done' });
    const pending = await create('Pending prerequisite');
    const third = await create('Third prerequisite');
    await post<Decision>(owner, `${path}/decisions`, { title: 'Plan direction' });
    const plan = await post<Material>(owner, `${path}/materials`, { title: 'Exact plan source', body: 'The bounded task plan', clientMutationId: randomUUID() });
    const planIntent = { materialId: plan.materialId, version: 1, intentKey: 'bounded-task-read' };
    const planned = await create('Planned task with mixed prerequisites', { criteria: ['First native criterion', 'Second native criterion'],
      dependencyIds: [third.id, ready.id, pending.id], planIntent });
    const observe = async (total: number, unmet: number) => {
      const page = await get<ProjectWorkView>(`${path}/work-view?group=open&limit=100`);
      const row = page.items.find(({ id }) => id === planned.id) as WorkRowProjection;
      assert.deepEqual(row.prerequisiteCounts, { total, unmet });
      for (const key of ['criteria', 'dependencyIds', 'prerequisites', 'planIntent', 'links']) assert.equal(key in row, false);
      const canonical = expectStatus(await owner.browser.request('GET', `/api/v1/work/${planned.id}`), 200) as WorkItem;
      const detail = await get<WorkDetailProjection>(`${path}/work-objects/work/${planned.id}`);
      assert.equal(detail.object.kind, 'work');
      if (detail.object.kind !== 'work') throw new Error('Wrong native detail kind');
      for (const field of ['criteria', 'dependencyIds', 'prerequisites', 'planIntent'] as const) assert.deepEqual(detail.object[field], canonical[field]);
      assert.deepEqual(detail.object.dependencyIds, [third.id, ready.id, pending.id].sort());
      assert.equal(detail.object.prerequisites.filter(({ met }) => !met).length, unmet);
      assert.deepEqual(detail.object.planIntent, planIntent);
      assert.equal('prerequisiteCounts' in detail.object, false);
      expectStatus(await outsider.browser.request('GET', `${path}/work-objects/work/${planned.id}`), 404);
      return page;
    };
    const initial = await observe(3, 2);
    // The Tasks tab lists tasks only (#342): `kinds=work` leaves decisions and results to the Inbox and to their tasks.
    const tasksOnly = await get<ProjectWorkView>(`${path}/work-view?kinds=work&limit=100`);
    const everything = await get<ProjectWorkView>(`${path}/work-view?limit=100`);
    assert.ok(tasksOnly.items.length > 0 && tasksOnly.items.every((item) => item.kind === 'work'));
    assert.ok(everything.items.some((item) => item.kind === 'decision'), 'API readers still get decisions in the whole view');
    assert.equal(tasksOnly.total, everything.items.filter((item) => item.kind === 'work').length, 'the total counts only tasks');
    const plain = initial.items.find(({ id }) => id === pending.id) as WorkRowProjection;
    assert.deepEqual(plain.prerequisiteCounts, { total: 0, unmet: 0 });
    const change = async (id: string, command: Record<string, unknown>) => {
      const task = expectStatus(await owner.browser.request('GET', `/api/v1/work/${id}`), 200) as WorkItem;
      return expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${id}`, { body: { ...command, clientCommandId: randomUUID() }, headers: { 'if-match': `"${task.version}"` } }), 200) as WorkItem;
    };
    await change(pending.id, { status: 'done' }); await observe(3, 1);
    await change(third.id, { status: 'done' }); await observe(3, 0);
    await change(ready.id, { status: 'open' }); await observe(3, 1);
    await assert.rejects(pool.query('INSERT INTO project_task_dependencies (workspace_id, project_id, task_id, prerequisite_id) VALUES ($1,$2,$3,$4)',
      [workspaceId, isolated.id, planned.id, main.id]), (error: unknown) => (error as { code?: string }).code === '23503');
    await observe(3, 1);
  });

  test('native task plan detail keeps the 50 prerequisite and 20 criterion boundaries while pages stay compact', async () => {
    const isolated = await project(owner, workspaceId, 'Native plan bounds', 'restricted');
    const path = `/api/v1/projects/${isolated.id}`;
    const prerequisites: WorkItem[] = [];
    for (let i = 0; i < 50; i++) prerequisites.push(await post<WorkItem>(owner, `${path}/work`, { title: `Bound prerequisite ${i}`, status: i % 2 ? 'done' : 'open' }));
    const criteria = Array.from({ length: 20 }, (_, i) => `${i}:` + 'x'.repeat(999 - String(i).length));
    const task = await post<WorkItem>(owner, `${path}/work`, { title: 'Task at native boundaries', criteria, dependencyIds: prerequisites.map(({ id }) => id) });
    const page = await get<ProjectWorkView>(`${path}/work-view?limit=1`);
    assert.equal(page.items.length, 1); assert.equal(page.total, 51); assert.equal(page.items[0]?.id, task.id);
    assert.deepEqual((page.items[0] as WorkRowProjection).prerequisiteCounts, { total: 50, unmet: 25 });
    const detail = await get<WorkDetailProjection>(`${path}/work-objects/work/${task.id}`);
    if (detail.object.kind !== 'work') throw new Error('Wrong native detail kind');
    assert.deepEqual(detail.object.criteria, criteria); assert.equal(detail.object.prerequisites.length, 50);
    assert.deepEqual(detail.object.dependencyIds, prerequisites.map(({ id }) => id).sort());
    assert.equal(detail.object.planIntent, null);
    const canonical = expectStatus(await owner.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
    assert.deepEqual(detail.object.prerequisites, canonical.prerequisites);
  });

  test('own details preserve full fields and native history without implicit links; finished selection stays separate', async () => {
    for (const [kind, id, field, expected] of [['work', main.id, 'outcome', 'Own full outcome'], ['decision', oldRule.id, 'rationale', 'Own full rationale']]) {
      const detail = await get<WorkDetailProjection>(`${base()}/work-objects/${kind}/${id}`);
      assert.equal(Reflect.get(detail.object, field!), expected); assert.equal('links' in detail.object, false); assert.equal('relations' in detail.object, false);
      assert.ok(detail.context.length <= 3);
      if (kind === 'decision') { assert.equal(detail.object.kind === 'decision' && detail.object.supersededBy, rule.id); assert.equal(detail.context[0]?.id, rule.id); }
    }
    const choice = await get<ProjectWorkView>(`${base()}/work-view?purpose=choices&choice=open_work&selected=${finished.id}&limit=1`);
    assert.equal(choice.total, 5); assert.equal(choice.items.length, 1); assert.equal(choice.selected?.id, finished.id);
    assert.equal(choice.items.some(({ id }) => id === finished.id), false);
  });

  test('association windows span all native object kinds and zero-link sources; edges use one global bound', async () => {
    const path = `${base()}/work-associations?conversationId=${conversation.id}&relation=any&limit=1`;
    const first = await get<WorkAssociations>(path);
    assert.equal(first.total, 2); assert.equal(first.items[0]?.id, main.id); assert.equal(first.edgeTotal, 3);
    assert.equal(first.edges.items.length, 1); assert.equal(first.edges.total, 2); assert.ok(first.edges.nextCursor);
    assert.deepEqual(first.sources, [{ messageId: conversation.messages[0]!.id, work: 1, decisions: 1, edges: 3 }, { messageId: zeroMessageId, work: 0, decisions: 0, edges: 0 }]);
    const edgeNext = await get<WorkAssociations>(`${path}&edgeCursor=${first.edges.nextCursor}`);
    assert.equal(edgeNext.edges.items.length, 1); assert.notEqual(edgeNext.edges.items[0]?.id, first.edges.items[0]?.id);
    const edgePrevious = await get<WorkAssociations>(`${path}&edgeCursor=${edgeNext.edges.previousCursor}`);
    assert.deepEqual(edgePrevious.edges.items, first.edges.items);
    const second = await get<WorkAssociations>(`${path}&cursor=${first.nextCursor}`);
    assert.equal(second.items[0]?.id, oldRule.id); assert.equal(second.edgeTotal, 3); assert.equal(second.sources[0]?.edges, 3); assert.equal(second.nextCursor, null);
    expectStatus(await owner.browser.request('GET', `${path}&cursor=${first.nextCursor}&edgeCursor=${first.edges.nextCursor}`), 400);
    const sourceOnly = await get<WorkAssociations>(`${base()}/work-associations?messageIds=${conversation.messages[0]!.id},${zeroMessageId}`);
    assert.equal(sourceOnly.edgeTotal, 2); assert.equal(sourceOnly.edges.items.length, 2); assert.equal(sourceOnly.sources[0]?.edges, 2);
  });

  test('relations page native versions/current labels and strictly reverse ascending keys without loading a full graph', async () => {
    const path = `${base()}/work-relations?objects=work:${main.id}&limit=2`;
    const first = await get<WorkRelations>(path); assert.equal(first.total, 6); assert.equal(first.items.length, 2);
    const second = await get<WorkRelations>(`${path}&cursor=${first.nextCursor}`);
    const previous = await get<WorkRelations>(`${path}&cursor=${second.previousCursor}`); assert.deepEqual(previous.items, first.items);
    const all = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}`);
    assert.deepEqual(all.items.filter(({ to }) => to.type === 'material').map(({ to, toTitle }) => [to.type === 'material' && to.version, toTitle]).sort((a, b) => Number(a[0]) - Number(b[0])), [[1, 'Material v1'], [2, 'Material v2']]);
    assert.equal(all.items.find(({ to }) => to.id === thoughtId)?.sketchId, sketchId);
    assert.equal(all.items.find(({ to }) => to.type === 'message')?.toTitle, 'Actual source opening');
    const only = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}&role=source`); assert.equal(only.total, 4);
  });

  test('same-kind objects elsewhere or missing selectors never pass a readable project predicate', async () => {
    const foreignProject = await project(owner, workspaceId, 'Foreign selector project', 'restricted');
    const foreignWork = await post<WorkItem>(owner, `/api/v1/projects/${foreignProject.id}/work`, { title: 'Foreign' });
    const foreignDecision = await post<Decision>(owner, `/api/v1/projects/${foreignProject.id}/decisions`, { title: 'Foreign' });
    for (const [kind, id] of [['work', foreignWork.id], ['decision', foreignDecision.id], ['work', randomUUID()], ['decision', randomUUID()]]) {
      expectStatus(await owner.browser.request('GET', `${base()}/work-relations?objects=${kind}:${id}`), 404);
      expectStatus(await owner.browser.request('GET', `${base()}/work-objects/${kind}/${id}`), 404);
      if (kind === 'work') expectStatus(await owner.browser.request('GET', `${base()}/work-view?purpose=choices&choice=open_work&selected=${id}`), 404);
    }
    expectStatus(await owner.browser.request('GET', `${base()}/work-associations?messageIds=${randomUUID()}`), 404);
    expectStatus(await owner.browser.request('GET', `${base()}/work-associations?conversationId=${randomUUID()}`), 404);
    for (const suffix of ['work-summary', 'work-view', `work-objects/work/${main.id}`, `work-relations?objects=work:${main.id}`, `work-associations?conversationId=${conversation.id}`]) {
      expectStatus(await outsider.browser.request('GET', `${base()}/${suffix}`), 404);
      expectStatus(await new Browser().request('GET', `${base()}/${suffix}`), 401);
    }
    for (const query of ['limit=1&limit=1', 'limit=101', 'unknown=x', 'purpose=choices&choice=parked_work']) expectStatus(await owner.browser.request('GET', `${base()}/work-view?${query}`), 400);
    expectStatus(await owner.browser.request('GET', `${base()}/work-summary?limit=1`), 400);
  });

  async function readsAfter(browser: Browser, mutate: () => Promise<unknown>) {
    const headers = { cookie: browser.cookieHeader() };
    const session = await sessions.requirePrincipal({ headers });
    const native = nativeWorkReadUnitOfWork(db);
    const held: WorkReadUnitOfWork = { run: async (read) => { const value = await native.run(read); await mutate(); return value; } };
    return { actor: session.principal, reads: createBoundedWorkReads(held, nativeWorkReadFinalFence(db, sessions, session, headers)) };
  }

  test('actual exact native SID revocation, expiry and current project denial suppress assembled responses', async () => {
    for (const expired of [false, true]) {
      const session = await secondSession(other);
      const held = await readsAfter(session.browser, () => expired
        ? pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [session.sessionId])
        : pool.query('DELETE FROM auth_sessions WHERE id = $1', [session.sessionId]));
      await assert.rejects(held.reads.summary(held.actor, projectId), code(401, 'UNAUTHENTICATED'));
      assert.equal((await other.browser.request('GET', `${base()}/work-summary`)).status, 200, 'another live session is unaffected');
    }
    const held = await readsAfter(other.browser, () => removeFromSpace(owner, projectId, other));
    try { await assert.rejects(held.reads.summary(held.actor, projectId), { status: 404 }); }
    finally { await grant(owner, projectId, other, 'contributor'); }
  });

  test('exact SID is checked after the final awaited native project policy, including revocation/expiry during it', async () => {
    for (const expired of [false, true]) {
      const session = await secondSession(other), headers = { cookie: session.browser.cookieHeader() };
      const initial = await sessions.requirePrincipal({ headers });
      let policyReads = 0;
      const revoke = () => expired
        ? pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [session.sessionId])
        : pool.query('DELETE FROM auth_sessions WHERE id = $1', [session.sessionId]);
      // Hold the final completed policy statement, the person's read of the space with their level (composed once and prepared, #1178),
      // at the connection it is sent on; every row/level still comes from the actual current central policy.
      const policyRead = (text: unknown) => typeof text === 'string' && /AS level\s+FROM projects p WHERE p\.id = \$/.test(text);
      const client = (db as unknown as { session: { client: { query: (...args: unknown[]) => Promise<unknown> } } }).session.client;
      const heldClient = new Proxy(client, { get(target, name) {
        const member = Reflect.get(target, name, target) as unknown;
        if (name !== 'query' || typeof member !== 'function') return typeof member === 'function' ? (member as (...args: unknown[]) => unknown).bind(target) : member;
        return async (...args: unknown[]) => {
          const result = await (member as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          if (policyRead((args[0] as { text?: unknown } | undefined)?.text) && ++policyReads === 2) await revoke();
          return result;
        };
      } });
      const heldSession = new Proxy((db as unknown as { session: object }).session, { get(target, name) {
        return name === 'client' ? heldClient : Reflect.get(target, name, target);
      } });
      const held = new Proxy(db, { get(target, name, receiver) { return name === 'session' ? heldSession : Reflect.get(target, name, receiver); } });
      const reads = createBoundedWorkReads(nativeWorkReadUnitOfWork(db), nativeWorkReadFinalFence(held, sessions, initial, headers));
      await assert.rejects(reads.summary(initial.principal, projectId), code(401, 'UNAUTHENTICATED'));
      assert.equal(policyReads, 2);
      assert.ok(await sessions.resolveSession({ cookie: other.browser.cookieHeader() }), 'an unrelated live SID cannot substitute');
    }
  });

  test('native observations are read-only REPEATABLE READ and all five reads leave project content/events unchanged', async () => {
    let settings: { isolation: string; readOnly: string } | undefined;
    const observed = new Proxy(db, { get(target, name, receiver) {
      if (name !== 'transaction') return Reflect.get(target, name, receiver);
      return (read: (tx: Transaction) => Promise<unknown>, options: unknown) => Reflect.apply(target.transaction, target, [async (tx: Transaction) => {
        settings = (await tx.execute<{ isolation: string; readOnly: string }>(sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`)).rows[0];
        return read(tx);
      }, options]);
    } });
    const headers = { cookie: owner.browser.cookieHeader() }, initial = await sessions.requirePrincipal({ headers });
    const reads = createBoundedWorkReads(nativeWorkReadUnitOfWork(observed), nativeWorkReadFinalFence(db, sessions, initial, headers));
    const digest = async () => (await pool.query(`WITH facts AS (
      SELECT 'work:' || id::text AS key, row_to_json(w)::text AS fact FROM project_work_items w WHERE project_id = $1
      UNION ALL SELECT 'decision:' || id::text, row_to_json(d)::text FROM project_decisions d WHERE project_id = $1
      UNION ALL SELECT 'link:' || id::text, row_to_json(l)::text FROM project_object_links l WHERE project_id = $1
      UNION ALL SELECT 'message:' || id::text, row_to_json(m)::text FROM project_messages m WHERE project_id = $1
      UNION ALL SELECT 'event:' || id::text, row_to_json(e)::text FROM events e WHERE object_id = $1)
      SELECT md5(string_agg(fact, ',' ORDER BY key)) AS digest FROM facts`, [projectId])).rows;
    const original = await digest();
    await reads.summary(initial.principal, projectId);
    assert.deepEqual(settings, { isolation: 'repeatable read', readOnly: 'on' });
    for (const suffix of ['work-summary', 'work-view?limit=1', `work-objects/work/${main.id}`, `work-relations?objects=work:${main.id}&limit=1`, `work-associations?conversationId=${conversation.id}&limit=1`]) await get(`${base()}/${suffix}`);
    assert.deepEqual(await digest(), original);
  });

  test('every required zero-link selector is checked after its observation, ahead of source drift', async () => {
    for (const route of ['detail', 'relations', 'selected'] as const) {
      const isolated = await project(owner, workspaceId, `Current selector ${route}`, 'restricted');
      const work = await post<WorkItem>(owner, `/api/v1/projects/${isolated.id}/work`, { title: 'Zero-link native object' });
      const held = await readsAfter(owner.browser, () => pool.query('DELETE FROM project_work_items WHERE project_id = $1 AND id = $2', [isolated.id, work.id]));
      const read = route === 'detail' ? held.reads.detail(held.actor, isolated.id, 'work', work.id)
        : route === 'relations' ? held.reads.relations(held.actor, isolated.id, new URLSearchParams(`objects=work:${work.id}`))
          : held.reads.view(held.actor, isolated.id, new URLSearchParams(`purpose=choices&choice=open_work&selected=${work.id}`));
      await assert.rejects(read, { status: 404 });
    }
  });

  test('private thought endpoints vanish before count/title projection and drift invalidates an older observation', async () => {
    const held = await readsAfter(owner.browser, () => pool.query("UPDATE sketches SET scope = 'private', project_id = NULL, version = version + 1 WHERE id = $1", [sketchId]));
    try {
      await assert.rejects(held.reads.view(held.actor, projectId, new URLSearchParams()), code(409, 'work_read_changed'));
      const relations = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}`);
      assert.equal(relations.total, 5); assert.equal(relations.items.some(({ to }) => to.id === thoughtId), false);
      assert.equal(JSON.stringify(relations).includes('Actual thought opening'), false);
      const detail = await get<WorkDetailProjection>(`${base()}/work-objects/work/${main.id}`); assert.equal(detail.relations.edges, 5);
    } finally { await pool.query("UPDATE sketches SET scope = 'project', project_id = $2, version = version + 1 WHERE id = $1", [sketchId, projectId]); }
  });

  test('unreturned zero-link conversation messages contribute to current source fingerprints and count windows', async () => {
    const extra = await post<Conversation>(owner, `${base()}/conversations`, { body: 'First zero-link source', clientMessageId: randomUUID() });
    const ids = [extra.messages[0]!.id];
    for (let i = 0; i < 100; i++) ids.push((await post<{ id: string }>(owner, `/api/v1/conversations/${extra.id}/messages`, { body: `Zero-link ${i}`, clientMessageId: randomUUID() })).id);
    const first = await get<WorkAssociations>(`${base()}/work-associations?conversationId=${extra.id}&limit=1`);
    assert.equal(first.sourceTotal, 101); assert.equal(first.sources.length, 100); assert.equal(first.items.length, 0); assert.ok(first.sourceNextCursor);
    assert.ok(first.sources.every(({ edges }) => edges === 0)); assert.equal(first.sources.some(({ messageId }) => messageId === ids.at(-1)), false);
    const next = await get<WorkAssociations>(`${base()}/work-associations?conversationId=${extra.id}&limit=1&sourceCursor=${first.sourceNextCursor}`);
    assert.deepEqual(next.sources.map(({ messageId }) => messageId), [ids.at(-1)]);
    const previous = await get<WorkAssociations>(`${base()}/work-associations?conversationId=${extra.id}&limit=1&sourceCursor=${next.sourcePreviousCursor}`); assert.deepEqual(previous.sources, first.sources);
    const held = await readsAfter(owner.browser, () => pool.query('DELETE FROM project_messages WHERE id = $1', [ids.at(-1)]));
    await assert.rejects(held.reads.associations(held.actor, projectId, new URLSearchParams(`conversationId=${extra.id}&limit=1`)), code(409, 'work_read_changed'));
    const current = await get<WorkAssociations>(`${base()}/work-associations?conversationId=${extra.id}&limit=1`); assert.equal(current.sourceTotal, 100);
  });

  test('held actual native SQL retains message count selector and expected relation batch despite caller mutation', async () => {
    const selection: NativeWorkAssociationSelector = { messageIds: [conversation.messages[0]!.id], relation: 'any' };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = db.transaction(async (tx) => {
      let first = true;
      const held = new Proxy(tx, { get(target, name, receiver) {
        if (name !== 'execute') return Reflect.get(target, name, receiver);
        return async (...args: unknown[]) => { const value = await Reflect.apply(target.execute, target, args); if (first) { first = false; entered(); await gate; } return value; };
      } });
      return nativeWorkAssociationRows(held).sourceCounts(projectId, selection);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    await Promise.race([started, pending]); selection.messageIds[0] = zeroMessageId; selection.relation = 'source'; release();
    const counts = await pending;
    assert.equal(counts.items[0]?.value.messageId, conversation.messages[0]!.id); assert.equal(counts.items[0]?.value.edges, 3);
    let enteredRelations!: () => void, releaseRelations!: () => void;
    const startedRelations = new Promise<void>((resolve) => { enteredRelations = resolve; }), gateRelations = new Promise<void>((resolve) => { releaseRelations = resolve; });
    const refs = [{ kind: 'work' as const, id: main.id }];
    const pendingRelations = db.transaction(async (tx) => {
      const held = new Proxy(tx, { get(target, name, receiver) {
        if (name !== 'execute') return Reflect.get(target, name, receiver);
        return async (...args: unknown[]) => { const value = await Reflect.apply(target.execute, target, args); enteredRelations(); await gateRelations; return value; };
      } });
      return nativeWorkVisibilityRows(held).relations(projectId, refs);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    await Promise.race([startedRelations, pendingRelations]); refs.push({ kind: 'work', id: randomUUID() }); releaseRelations();
    const relations = await pendingRelations; assert.equal(relations.length, 1); assert.equal(relations[0]?.edges, 6);
  });
});
