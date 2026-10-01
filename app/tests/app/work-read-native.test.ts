import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, nativeWorkAssociationRows, nativeWorkVisibilityRows, type NativeWorkAssociationSelector } from '@flux/db';
import { createBoundedWorkReads, DomainError, type WorkReadUnitOfWork } from '@flux/core';
import type { Agent, Conversation, Decision, Material, ProjectWorkSummary, ProjectWorkView, WorkAssociations, WorkDetailProjection, WorkItem, WorkRelations, WorkResult, WorkRowProjection } from '@flux/contracts';
import { nativeWorkReadFinalFence, nativeWorkReadUnitOfWork } from '../../apps/server/src/work-read/adapters.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createSessionResolver } from '../../apps/server/src/identity/session.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, secondSession, workspace, type Person } from './support/people.js';

// Real native commands, HTTP cookies and PostgreSQL observations. Holds wrap actual
// reads, never substitute native session/project authority with a fabricated port.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
after(() => pool.end());
const sessions = createSessionResolver(createAuth({ db, config: loadIdentityConfig(), mailer: null }));
const post = async <T>(who: Person, path: string, body: unknown, headers?: Record<string, string>) => expectStatus(await who.browser.request('POST', path, { body, headers }), 201) as T;
const code = (status: number, expected: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === expected;

describe('bounded native work reads through HTTP and current native fences', () => {
  let owner: Person, other: Person, viewer: Person, outsider: Person;
  let workspaceId: string, projectId: string;
  let conversation: Conversation, main: WorkItem, finished: WorkItem, parked: WorkItem;
  let oldRule: Decision, rule: Decision, result: WorkResult, material: Material;
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
    await grant(owner, projectId, other, 'contributor'); await grant(owner, projectId, viewer, 'viewer');
    const agents = await Promise.all([0, 1].map(() => post<Agent>(owner, `/api/v1/workspaces/${workspaceId}/agents`, { name: 'Ada', owner: 'workspace' })));
    for (const agent of agents) await post(owner, `${base()}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
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
    parked = await addWork('Shelved native work', { status: 'in_progress', owner: { kind: 'human', id: other.id } });
    const proposal = await post<Decision>(other, `${base()}/decisions`, { title: 'Earlier native rule', rationale: 'Own full rationale', affects: [main.id], sources: [message] });
    oldRule = expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${proposal.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200) as Decision;
    const pivot = await post<Decision>(other, `${base()}/decisions`, { title: 'Current native rule', supersedes: oldRule.id });
    rule = expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${pivot.id}/accept`, { body: { park: [parked.id] }, headers: { 'if-match': '"1"' } }), 200) as Decision;
    result = await post<WorkResult>(other, `${base()}/results`, { title: 'Native result', finding: 'negative', evidence: 'Own full evidence', work: [main.id], sources: [message] });
  });

  test('same-name humans and agents remain distinct bounded owners; view and summary share native observation', async () => {
    const summary = await get<ProjectWorkSummary>(`${base()}/work-summary`);
    assert.deepEqual(summary.all, { needs: 0, in_progress: 4, blocked: 0, open: 1, parked: 1, finished: 1, rules: 2, results: 1 });
    assert.equal(summary.workTotal, 7); assert.equal(summary.unfinishedTotal, 5);
    assert.equal(summary.state.active.ownerTotal, 4); assert.equal(summary.state.active.owners.length, 3);
    assert.equal(new Set(summary.state.active.owners.map((owner) => `${owner.kind}:${owner.id}`)).size, 3);
    assert.ok(summary.state.active.owners.every(({ name }) => name === 'Ada'));
    assert.equal(summary.state.rule?.id, rule.id); assert.equal(summary.state.result?.id, result.id);
    const first = await get<ProjectWorkView>(`${base()}/work-view?limit=3`, viewer);
    assert.equal(first.items.length, 3); assert.equal(first.total, 10); assert.equal(first.summary.access, 'viewer');
    assert.deepEqual(first.summary.all, summary.all); assert.match(first.summary.observedAt, /\.\d{6}Z$/);
    const seen = [...first.items]; let next = first.nextCursor;
    while (next) { const page = await get<ProjectWorkView>(`${base()}/work-view?limit=3&cursor=${next}`); seen.push(...page.items); next = page.nextCursor; }
    assert.equal(new Set(seen.map(({ kind, id }) => `${kind}:${id}`)).size, 10);
    assert.deepEqual(seen.filter(({ kind }) => kind === 'decision').map(({ id }) => id), [rule.id, oldRule.id]);
    for (const row of seen) for (const forbidden of ['links', 'outcome', 'rationale', 'evidence', 'createdByKind', 'ownerUserId', 'parkedByDecisionId']) assert.equal(forbidden in row, false);
    const projected = seen.find(({ id }) => id === main.id) as WorkRowProjection;
    assert.deepEqual(projected.relations, { edges: 7, sourceMessages: 1, sourceMaterials: 2, decisions: 1, results: 1 });
    assert.equal(projected.rule?.id, oldRule.id);
    const parkedRow = seen.find(({ id }) => id === parked.id) as WorkRowProjection;
    assert.equal(parkedRow.parked?.decisionId, rule.id); assert.equal(parkedRow.parkedBy?.title, rule.title);
    const resultRow = seen.find(({ id }) => id === result.id)!; assert.equal('version' in resultRow, false);
    const mine = await get<ProjectWorkView>(`${base()}/work-view?mine=true`);
    assert.equal(mine.summary.mine.in_progress, 1); assert.equal(mine.summary.mine.rules, 0); assert.equal(mine.summary.mine.results, 0);
    assert.equal(mine.total, 1);
  });

  test('own details preserve full fields and native history without implicit links; finished selection stays separate', async () => {
    for (const [kind, id, field, expected] of [['work', main.id, 'outcome', 'Own full outcome'], ['decision', oldRule.id, 'rationale', 'Own full rationale'], ['result', result.id, 'evidence', 'Own full evidence']]) {
      const detail = await get<WorkDetailProjection>(`${base()}/work-objects/${kind}/${id}`);
      assert.equal(Reflect.get(detail.object, field!), expected); assert.equal('links' in detail.object, false); assert.equal('relations' in detail.object, false);
      assert.ok(detail.context.length <= 3);
      if (kind === 'decision') { assert.equal(detail.object.kind === 'decision' && detail.object.supersededBy, rule.id); assert.equal(detail.context[0]?.id, rule.id); }
    }
    const choice = await get<ProjectWorkView>(`${base()}/work-view?purpose=choices&choice=result_work&selected=${finished.id}&limit=1`);
    assert.equal(choice.total, 6); assert.equal(choice.items.length, 1); assert.equal(choice.selected?.id, finished.id);
    assert.equal(choice.items.some(({ id }) => id === finished.id), false);
    const parkedChoice = await get<ProjectWorkView>(`${base()}/work-view?purpose=choices&choice=parked_work&decisionId=${rule.id}`);
    assert.deepEqual(parkedChoice.items.map(({ id }) => id), [parked.id]);
  });

  test('association windows span all native object kinds and zero-link sources; edges use one global bound', async () => {
    const path = `${base()}/work-associations?conversationId=${conversation.id}&relation=any&limit=1`;
    const first = await get<WorkAssociations>(path);
    assert.equal(first.total, 3); assert.equal(first.items[0]?.id, main.id); assert.equal(first.edgeTotal, 4);
    assert.equal(first.edges.items.length, 1); assert.equal(first.edges.total, 2); assert.ok(first.edges.nextCursor);
    assert.deepEqual(first.sources, [{ messageId: conversation.messages[0]!.id, work: 1, decisions: 1, results: 1, edges: 4 }, { messageId: zeroMessageId, work: 0, decisions: 0, results: 0, edges: 0 }]);
    const edgeNext = await get<WorkAssociations>(`${path}&edgeCursor=${first.edges.nextCursor}`);
    assert.equal(edgeNext.edges.items.length, 1); assert.notEqual(edgeNext.edges.items[0]?.id, first.edges.items[0]?.id);
    const edgePrevious = await get<WorkAssociations>(`${path}&edgeCursor=${edgeNext.edges.previousCursor}`);
    assert.deepEqual(edgePrevious.edges.items, first.edges.items);
    const second = await get<WorkAssociations>(`${path}&cursor=${first.nextCursor}`);
    assert.equal(second.items[0]?.id, oldRule.id); assert.equal(second.edgeTotal, 4); assert.equal(second.sources[0]?.edges, 4);
    const third = await get<WorkAssociations>(`${path}&cursor=${second.nextCursor}`); assert.equal(third.items[0]?.id, result.id);
    expectStatus(await owner.browser.request('GET', `${path}&cursor=${first.nextCursor}&edgeCursor=${first.edges.nextCursor}`), 400);
    const sourceOnly = await get<WorkAssociations>(`${base()}/work-associations?messageIds=${conversation.messages[0]!.id},${zeroMessageId}`);
    assert.equal(sourceOnly.edgeTotal, 3); assert.equal(sourceOnly.edges.items.length, 3); assert.equal(sourceOnly.sources[0]?.edges, 3);
  });

  test('relations page native versions/current labels and strictly reverse ascending keys without loading a full graph', async () => {
    const path = `${base()}/work-relations?objects=work:${main.id}&limit=2`;
    const first = await get<WorkRelations>(path); assert.equal(first.total, 7); assert.equal(first.items.length, 2);
    const second = await get<WorkRelations>(`${path}&cursor=${first.nextCursor}`);
    const previous = await get<WorkRelations>(`${path}&cursor=${second.previousCursor}`); assert.deepEqual(previous.items, first.items);
    const all = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}`);
    assert.deepEqual(all.items.filter(({ to }) => to.type === 'material').map(({ to, toTitle }) => [to.type === 'material' && to.version, toTitle]), [[1, 'Material v1'], [2, 'Material v2']]);
    assert.equal(all.items.find(({ to }) => to.id === thoughtId)?.sketchId, sketchId);
    assert.equal(all.items.find(({ to }) => to.type === 'message')?.toTitle, 'Actual source opening');
    const only = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}&role=source`); assert.equal(only.total, 4);
  });

  test('same-kind objects elsewhere or missing selectors never pass a readable project predicate', async () => {
    const foreignProject = await project(owner, workspaceId, 'Foreign selector project', 'restricted');
    const foreignWork = await post<WorkItem>(owner, `/api/v1/projects/${foreignProject.id}/work`, { title: 'Foreign' });
    const foreignDecision = await post<Decision>(owner, `/api/v1/projects/${foreignProject.id}/decisions`, { title: 'Foreign' });
    const foreignResult = await post<WorkResult>(owner, `/api/v1/projects/${foreignProject.id}/results`, { title: 'Foreign', finding: 'negative' });
    for (const [kind, id] of [['work', foreignWork.id], ['decision', foreignDecision.id], ['result', foreignResult.id], ['work', randomUUID()], ['decision', randomUUID()], ['result', randomUUID()]]) {
      expectStatus(await owner.browser.request('GET', `${base()}/work-relations?objects=${kind}:${id}`), 404);
      expectStatus(await owner.browser.request('GET', `${base()}/work-objects/${kind}/${id}`), 404);
      if (kind === 'work') expectStatus(await owner.browser.request('GET', `${base()}/work-view?purpose=choices&choice=result_work&selected=${id}`), 404);
    }
    expectStatus(await owner.browser.request('GET', `${base()}/work-associations?messageIds=${randomUUID()}`), 404);
    expectStatus(await owner.browser.request('GET', `${base()}/work-associations?conversationId=${randomUUID()}`), 404);
    expectStatus(await owner.browser.request('GET', `${base()}/work-view?purpose=choices&choice=parked_work&decisionId=${foreignDecision.id}`), 404);
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
    const held = await readsAfter(other.browser, () => grant(owner, projectId, other, 'denied'));
    try { await assert.rejects(held.reads.summary(held.actor, projectId), { status: 404 }); }
    finally { await grant(owner, projectId, other, 'contributor'); }
  });

  test('every required zero-link selector is checked after its observation, ahead of source drift', async () => {
    for (const route of ['detail', 'relations', 'selected', 'parked'] as const) {
      const isolated = await project(owner, workspaceId, `Current selector ${route}`, 'restricted');
      const work = await post<WorkItem>(owner, `/api/v1/projects/${isolated.id}/work`, { title: 'Zero-link native object' });
      const proposed = await post<Decision>(owner, `/api/v1/projects/${isolated.id}/decisions`, { title: 'Zero-link native rule' });
      expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${proposed.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200);
      const held = await readsAfter(owner.browser, () => route === 'parked'
        ? pool.query('DELETE FROM project_decisions WHERE project_id = $1 AND id = $2', [isolated.id, proposed.id])
        : pool.query('DELETE FROM project_work_items WHERE project_id = $1 AND id = $2', [isolated.id, work.id]));
      const read = route === 'detail' ? held.reads.detail(held.actor, isolated.id, 'work', work.id)
        : route === 'relations' ? held.reads.relations(held.actor, isolated.id, new URLSearchParams(`objects=work:${work.id}`))
          : held.reads.view(held.actor, isolated.id, new URLSearchParams(route === 'selected' ? `purpose=choices&choice=result_work&selected=${work.id}` : `purpose=choices&choice=parked_work&decisionId=${proposed.id}`));
      await assert.rejects(read, { status: 404 });
    }
  });

  test('private thought endpoints vanish before count/title projection and drift invalidates an older observation', async () => {
    const held = await readsAfter(owner.browser, () => pool.query("UPDATE sketches SET scope = 'private', project_id = NULL, version = version + 1 WHERE id = $1", [sketchId]));
    try {
      await assert.rejects(held.reads.view(held.actor, projectId, new URLSearchParams()), code(409, 'work_read_changed'));
      const relations = await get<WorkRelations>(`${base()}/work-relations?objects=work:${main.id}`);
      assert.equal(relations.total, 6); assert.equal(relations.items.some(({ to }) => to.id === thoughtId), false);
      assert.equal(JSON.stringify(relations).includes('Actual thought opening'), false);
      const detail = await get<WorkDetailProjection>(`${base()}/work-objects/work/${main.id}`); assert.equal(detail.relations.edges, 6);
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
    assert.equal(counts.items[0]?.value.messageId, conversation.messages[0]!.id); assert.equal(counts.items[0]?.value.edges, 4);
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
    const relations = await pendingRelations; assert.equal(relations.length, 1); assert.equal(relations[0]?.edges, 7);
  });
});
