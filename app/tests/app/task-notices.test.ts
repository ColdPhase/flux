import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConflictError, createWorkUseCases, type Principal } from '@flux/core';
import type { Agent, Conversation, CreateWorkCommand, Page, TaskCreationNotice, WorkItem } from '@flux/contracts';
import { workUnitOfWork, workUseCases } from '../../apps/server/src/work/adapters.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { db, pool } from './support/db.js';

async function scene() {
  const [owner, writer, reader, outsider] = await Promise.all(['notice-owner', 'notice-writer', 'notice-reader', 'notice-outsider'].map(person));
  const ws = await workspace(owner, 'Task notice checks');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Sensor trial', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
  const first = expectStatus(await writer.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Jonas recorded the original camera question.', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const second = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Ada recorded a separate measurement constraint.', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const path = `/api/v1/projects/${place.id}/work`;
  const noticePath = `/api/v1/projects/${place.id}/task-notices`;
  const notices = async () => expectStatus(await reader.browser.request('GET', noticePath), 200) as Page<TaskCreationNotice>;
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_work_items WHERE project_id=$1) AS work,
    (SELECT count(*)::int FROM project_task_notices WHERE project_id=$1) AS notices,
    (SELECT count(*)::int FROM project_messages WHERE project_id=$1) AS messages,
    (SELECT count(*)::int FROM project_conversations WHERE project_id=$1) AS conversations,
    (SELECT count(*)::int FROM events WHERE object_id=$1) AS events`, [place.id])).rows[0];
  return { owner, writer, reader, outsider, ws, place, first, second, path, noticePath, notices, counts };
}

test('task creation keeps source messages intact and stores exactly one distinct trusted notice', async () => {
  const f = await scene();
  const command: CreateWorkCommand = { title: 'Compare the same trial', clientCommandId: randomUUID(),
    sources: [{ type: 'message', id: f.first.messages[0]!.id }, { type: 'message', id: f.second.messages[0]!.id }] };
  const before = await f.counts();
  const item = expectStatus(await f.writer.browser.request('POST', f.path, { body: command }), 201) as WorkItem;
  const page = await f.notices();
  assert.equal(page.total, 1);
  const notice = page.items[0]!;
  assert.deepEqual({ ...notice, id: undefined }, { id: undefined, workspaceId: f.ws.id, projectId: f.place.id,
    workId: item.id, workTitle: item.title, workNumber: item.number, kind: 'task.created', createdBy: item.createdBy,
    sources: command.sources, createdAt: item.createdAt });
  assert.notEqual(notice.id, item.id);
  assert.equal(notice.createdBy.id, f.writer.id);
  const after = await f.counts();
  assert.deepEqual(after, { ...before, work: 1, notices: 1, events: before.events + 1 });
  for (const original of [f.first, f.second]) {
    const actual = expectStatus(await f.owner.browser.request('GET', `/api/v1/conversations/${original.id}`), 200) as Conversation;
    assert.deepEqual(actual.messages, original.messages);
  }
  for (let i = 0; i < 3; i++) {
    expectStatus(await f.owner.browser.request('GET', `/api/v1/work/${item.id}`), 200);
    await f.notices();
  }
  assert.deepEqual(await f.counts(), after, 'opening/render reads never manufacture a notice or root');
  assert.equal((await f.outsider.browser.request('GET', f.noticePath)).status, 404);
  assert.equal((await f.reader.browser.request('POST', f.path, { body: { title: 'Forbidden' } })).status, 403);
});

test('same domain command serializes simultaneous API/helper retries without relying on transport cache', async () => {
  const f = await scene();
  const command = { title: 'Durable uncertain-response retry', clientCommandId: randomUUID() };
  const actor: Principal = { kind: 'human', id: f.writer.id };
  const [api, direct, duplicate] = await Promise.all([
    f.writer.browser.request('POST', f.path, { body: command }),
    workUseCases(db).createWork(actor, f.place.id, command),
    workUseCases(db).createWork(actor, f.place.id, command),
  ]);
  const created = expectStatus(api, 201) as WorkItem;
  assert.deepEqual([created.id, direct.id, duplicate.id], [created.id, created.id, created.id]);
  const again = expectStatus(await f.writer.browser.request('POST', f.path, { body: command }), 201) as WorkItem;
  assert.equal(again.id, created.id);
  assert.equal((await f.notices()).total, 1);
  assert.equal((await f.counts()).work, 1);
  const changed = await f.writer.browser.request('POST', f.path, { body: { ...command, title: 'Another payload' } });
  assert.equal(changed.status, 409);
  await assert.rejects(workUseCases(db).createWork(actor, f.place.id, { ...command, outcome: 'Changed' }), ConflictError);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  assert.equal((await f.writer.browser.request('POST', f.path, { body: command })).status, 404, 'durable identity is no new authority');
  assert.equal((await f.notices()).total, 1);
});

test('no-source and legacy no-key creation are atomic; a genuine agent remains the notice creator', async () => {
  const f = await scene();
  const legacy = expectStatus(await f.owner.browser.request('POST', f.path, { body: { title: 'Order a sample' } }), 201) as WorkItem;
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, {
    body: { name: 'Measurement agent', owner: 'workspace' },
  }), 201) as Agent;
  // Grants use an explicit typed principal, not a pretend human account.
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201);
  const created = await workUseCases(db).createWork({ kind: 'agent', id: agent.id }, f.place.id,
    { title: 'Agent-created comparison', clientCommandId: randomUUID() });
  const page = await f.notices();
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.find((notice) => notice.workId === legacy.id)!.sources, []);
  assert.deepEqual(page.items.find((notice) => notice.workId === created.id)!.createdBy,
    { kind: 'agent', id: agent.id, name: 'Measurement agent' });
  assert.deepEqual([(await f.counts()).messages, (await f.counts()).conversations], [2, 2]);
});

test('failure after notice insertion rolls back task, source links, notice and events together', async () => {
  const f = await scene();
  const before = await f.counts();
  const unit = workUnitOfWork(db);
  const injected = createWorkUseCases({ run: (action) => unit.run((ports) => action({ ...ports, work: {
    ...ports.work, async insertCreationNotice(item, sources) {
      await ports.work.insertCreationNotice(item, sources);
      throw new Error('injected failure after durable notice');
    },
  } })) });
  const command = { title: 'Keep failed save private', clientCommandId: randomUUID(),
    sources: [{ type: 'message' as const, id: f.first.messages[0]!.id }] };
  await assert.rejects(injected.createWork({ kind: 'human', id: f.writer.id }, f.place.id, command), /injected failure/);
  assert.deepEqual(await f.counts(), before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_object_links WHERE project_id=$1', [f.place.id])).rows[0].n, 0);
  const retry = await workUseCases(db).createWork({ kind: 'human', id: f.writer.id }, f.place.id, command);
  assert.equal((await f.notices()).items[0]!.workId, retry.id);
});
