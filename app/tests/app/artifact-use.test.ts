import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CreatedThought, Decision, Doc, GithubPullFacts, Sketch, Thought, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { nativeWorkInTransaction, workUseCases } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';
import { upload } from './support/project-erasure-scene.js';

// What counts as use of a task for the Undo of an unused AI-created task (#394, #238): a decision about it, a pull request or a published file does, an edit of a doc
// or a thought it cites does not (#553). The turn limit of an agent in the task's discussion does not depend on any of this (#868).
type Scene = Awaited<ReturnType<typeof actionScene>>;

async function unusedAiTask(f: Scene, command: Record<string, unknown>) {
  return db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const created = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId, command as never);
    await native.flushEvents();
    return created;
  });
}
const state = async (f: Scene, item: { id: string }) => ({
  used: (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].first_persisted_use_at as Date | null,
  undo: (expect(await f.owner.request('GET', `/api/v1/work/${item.id}`), 200) as unknown as WorkItem).creationUndo,
});
const eligible = { used: null, undo: { eligible: true, reason: 'eligible' } };
const undoRequest = (f: Scene, item: { id: string; version: number }) =>
  f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
const decide = (f: Scene, item: { id: string }) => f.owner.request('POST', `/api/v1/projects/${f.projectId}/decisions`,
  { body: { title: 'Real decision', rationale: 'Observed behavior', affects: [item.id] } });
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Artifact race exceeded 10s')), 10_000); })]); }
  finally { clearTimeout(timer); }
}

test('editing a doc an unused AI-created task links to keeps Undo; a decision about the task still ends it (#553)', async () => {
  const f = await actionScene(pool);
  let doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Measured work', body: 'Baseline content' } }), 201) as unknown as Doc;
  const item = await unusedAiTask(f, { title: 'Unused linked task' });
  // Creation can only pin a material version, and a later link is itself a use: seed the unpinned current-doc link directly.
  await pool.query(`INSERT INTO project_object_links(id,workspace_id,project_id,role,from_type,from_id,to_type,to_id,to_version,created_by_kind,created_by_id)
    VALUES($1,$2,$3,'related','work',$4,'doc',$5,NULL,'agent',$6)`, [randomUUID(), f.workspaceId, f.projectId, item.id, doc.id, f.agentId]);
  assert.deepEqual(await state(f, item), eligible);
  for (const body of ['A genuinely new observation.', 'Another real observation.']) {
    doc = expect(await f.owner.request('PATCH', `/api/v1/docs/${doc.id}`,
      { body: { body }, headers: { 'if-match': `"${doc.version}"`, 'idempotency-key': randomUUID() } }), 200) as unknown as Doc;
    assert.deepEqual(await state(f, item), eligible, 'a linked doc edit is not use of the task');
  }
  expect(await decide(f, item), 201);
  const used = await state(f, item);
  assert.ok(used.used, 'a decision about the task is a task-targeted use');
  assert.equal(used.undo?.eligible, false);
  assert.equal(used.undo?.reason, 'task_used');
  assert.equal((await undoRequest(f, item)).status, 409);
});

test('editing a thought an unused AI-created task links to keeps Undo; a decision about the task still ends it (#553)', async () => {
  const f = await actionScene(pool);
  const map = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Canonical source map', scope: 'project', projectId: f.projectId } }), 201) as unknown as Sketch;
  let thought = (expect(await f.owner.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { id: randomUUID(), text: 'Initial task source', x: 20, y: 20 }, headers: { 'idempotency-key': randomUUID() } }), 201) as unknown as CreatedThought).thought;
  const item = await unusedAiTask(f, { title: 'Unused thought-linked task', sources: [{ type: 'thought', id: thought.id }] });
  assert.deepEqual(await state(f, item), eligible);
  thought = expect(await f.owner.request('PATCH', `/api/v1/sketches/${map.id}/thoughts/${thought.id}`,
    { body: { text: 'A genuinely new measured result' }, headers: { 'if-match': `"${thought.version}"`, 'idempotency-key': randomUUID() } }), 200) as unknown as Thought;
  assert.deepEqual(await state(f, item), eligible, 'a linked thought edit is not use of the task');
  toolValue(await f.tool('flux_update_thought', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute',
    sources: [], mapId: map.id, thoughtId: thought.id, expectedVersion: thought.version, changes: { text: 'Native content progress' } }));
  assert.deepEqual(await state(f, item), eligible);
  expect(await decide(f, item), 201);
  const used = await state(f, item);
  assert.ok(used.used);
  assert.equal(used.undo?.reason, 'task_used');
});

/**
 * The GitHub provider seam with one private repository the owner reaches: no vendor account, network or spend. Its App id is this file's
 * own: a webhook in github.test.ts, running alongside on the same database, is admitted to every active binding of its App's repository.
 */
class OnePull implements GithubProvider {
  constructor(readonly ownerId: string, readonly generation = randomUUID()) {}
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    if (principal.id !== this.ownerId || installationId !== '555' || repositoryId !== '777') throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'fixture', name: 'lamp', private: true, url: 'https://github.com/fixture/lamp',
      githubUserId: '999', appId: '13579', authorizationGeneration: this.generation };
  }
  async pull(principal: Principal, repository: { repositoryId: string }, number: number): Promise<GithubPullFacts> {
    await this.repository(principal, '555', repository.repositoryId);
    return { repositoryId: '777', pullId: `777${number}`, number, title: 'Measure the lamp', url: `https://github.com/fixture/lamp/pull/${number}`,
      author: { id: '765', login: 'source-author' }, headSha: 'a'.repeat(40), state: 'open', draft: false, merged: false, sourceCreatedAt: '2026-11-01T10:00:00Z',
      sourceUpdatedAt: '2026-11-02T10:00:00Z', sourceMergedAt: null, checks: [], reviews: [], truncated: false, execution: 'ready_for_review' };
  }
}

test('a pull request linked to an unused AI-created task, or a file published in its discussion, is use of it: Undo is refused', async () => {
  const f = await actionScene(pool);
  const owner: Principal = { kind: 'human', id: (expect(await f.owner.request('GET', '/api/v1/me'), 200).user as { id: string }).id };
  const refused = async (item: { id: string }) => {
    const now = await state(f, item);
    assert.ok(now.used, 'the task is used');
    assert.equal(now.undo?.reason, 'task_used');
    assert.equal((await undoRequest(f, await f.read(item.id) as unknown as WorkItem)).status, 409, 'and its Undo is refused at its current version');
  };
  const linked = await unusedAiTask(f, { title: 'Unused task with a pull request' });
  assert.deepEqual(await state(f, linked), eligible);
  const github = createGithubUseCases(db, new OnePull(owner.id));
  const binding = await github.bind(owner, f.projectId, { installationId: '555', repositoryId: '777' });
  assert.deepEqual(await state(f, linked), eligible, 'connecting the repository is not use of a task');
  await github.link(owner, linked.id, { bindingId: binding.id, number: 42, role: 'related' });
  await refused(linked);

  const filed = await unusedAiTask(f, { title: 'Unused task with a file' });
  const file = await upload(f, 'Measured: 3 W at full brightness.');
  assert.deepEqual(await state(f, filed), eligible, 'an upload that is not published is not use');
  expect(await f.owner.request('POST', `/api/v1/work/${filed.id}/discussion`, { body: { body: 'The measurement', attachmentIds: [file.id], clientMessageId: randomUUID() } }), 201);
  assert.ok((await pool.query('SELECT published_at FROM project_files WHERE id = $1', [file.id])).rows[0].published_at, 'the file is published in the discussion');
  await refused(filed);
});

test('a decision that affects an unused AI-created task is use of it, and so is its acceptance', async () => {
  const f = await actionScene(pool);
  const item = await unusedAiTask(f, { title: 'Unused decision target' });
  const other = await unusedAiTask(f, { title: 'Unused bystander' });
  assert.deepEqual(await state(f, item), eligible);
  const decision = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/decisions`,
    { body: { title: 'Keep the rule', rationale: 'Observed data', affects: [item.id] } }), 201) as unknown as Decision;
  const used = await state(f, item);
  assert.ok(used.used, 'a decision that affects the task is use of it');
  assert.equal(used.undo?.reason, 'task_used');
  assert.deepEqual(await state(f, other), eligible, 'a task the decision does not name is untouched');
  expect(await f.owner.request('POST', `/api/v1/decisions/${decision.id}/accept`, { body: {}, headers: { 'if-match': '"1"' } }), 200);
  assert.equal((await undoRequest(f, item)).status, 409);
});

test('a decision about an unused AI-created task and the Undo of that task have both forced orders, with one winner and no partial effect', { timeout: 60_000 }, async () => {
  for (const winner of ['decision', 'undo'] as const) {
    const f = await actionScene(pool);
    const saved = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId: randomUUID(),
      peerRequestClass: 'execute', sources: [], task: { title: 'Unused artifact target' } }));
    const item = await f.read(String(saved.workId)) as unknown as WorkItem;
    const ownerId = (expect(await f.owner.request('GET', '/api/v1/me'), 200).user as { id: string }).id;
    const command = { title: 'Real decision', rationale: 'Observed behavior', affects: [item.id] };
    const held = barrier<number>(), release = barrier();
    let other: Promise<unknown> | undefined;
    const first = db.transaction(async (tx) => {
      if (winner === 'decision') await workUseCases(tx).proposeDecision({ kind: 'human', id: ownerId }, f.projectId, command);
      else await workUseCases(tx).undoTaskCreation({ kind: 'human', id: ownerId }, item.id, { clientCommandId: randomUUID(), expectedVersion: item.version });
      held.resolve(await backendPid(tx));
      await bounded(release.promise);
    });
    void first.catch(() => undefined);
    try {
      const pid = await bounded(held.promise);
      other = winner === 'decision' ? undoRequest(f, item) : f.owner.request('POST', `/api/v1/projects/${f.projectId}/decisions`, { body: command });
      void other.catch(() => undefined);
      await waitUntilBlockedBy(pool, pid);
      release.resolve();
      await bounded(first);
      assert.equal((await bounded(other) as { status: number }).status, 409, 'the loser is refused');
      const decisions = (await pool.query("SELECT count(*)::int n FROM project_object_links WHERE to_id=$1 AND to_type='work' AND role='affects'", [item.id])).rows[0].n;
      assert.equal(decisions, winner === 'decision' ? 1 : 0);
      const reverted = (await pool.query('SELECT creation_reverted_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].creation_reverted_at;
      assert.equal(reverted !== null, winner === 'undo');
    } finally { release.resolve(); await bounded(Promise.all([first.catch(() => undefined), other?.catch(() => undefined)])); }
  }
});
