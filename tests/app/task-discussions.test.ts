import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { ConflictError, createTaskDiscussionUseCases } from '@flux/core';
import type { Conversation, ConversationMessage, Material, TaskDiscussion, WorkItem } from '@flux/contracts';
import { taskDiscussionUnitOfWork, taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

async function scene() {
  const [owner, writer, reader, outsider] = await Promise.all(['root-owner', 'root-writer', 'root-reader', 'root-outsider'].map(person));
  const ws = await workspace(owner, 'Genuine task roots');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Trial discussion', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title: 'Compare current measurements', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const path = `/api/v1/work/${task.id}/discussion`;
  const read = async (query = '') => expectStatus(await reader.browser.request('GET', path + query), 200) as TaskDiscussion;
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_task_discussions WHERE project_id=$1) AS bindings,
    (SELECT count(*)::int FROM project_messages WHERE project_id=$1) AS messages,
    (SELECT count(*)::int FROM project_conversations WHERE project_id=$1) AS conversations,
    (SELECT count(*)::int FROM events WHERE object_id=$1) AS events`, [place.id])).rows[0];
  return { owner, writer, reader, outsider, ws, place, task, path, read, counts };
}

test('opening a task remains empty; simultaneous genuine authors create one exact canonical root', async () => {
  const f = await scene();
  const before = await f.counts();
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.read(), { workId: f.task.id, workspaceId: f.ws.id,
    projectId: f.place.id, conversationId: null, rootMessageId: null, root: null, messages: [],
    messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } });
  assert.deepEqual(await f.counts(), before);
  const a = { body: 'Ada proposes a real measurement.', clientMessageId: randomUUID() };
  const b = { body: 'Jonas records a real counterexample.', clientMessageId: randomUUID() };
  const [owner, writer, duplicate] = await Promise.all([
    f.owner.browser.request('POST', f.path, { body: a }),
    f.writer.browser.request('POST', f.path, { body: b }),
    taskDiscussionUseCases(db).contribute({ kind: 'human', id: f.owner.id }, f.task.id, { ...a, clientMessageId: a.clientMessageId.toUpperCase() }),
  ]);
  const one = expectStatus(owner, 201) as ConversationMessage;
  const two = expectStatus(writer, 201) as ConversationMessage;
  assert.equal(one.id, duplicate.id);
  assert.equal(one.conversationId, two.conversationId);
  assert.deepEqual([one.sequence, two.sequence].sort(), [1, 2]);
  const discussion = await f.read();
  const first = one.sequence === 1 ? one : two;
  assert.deepEqual(discussion.root, first);
  assert.equal(discussion.rootMessageId, first.id);
  assert.deepEqual(discussion.messages, [one, two].sort((x, y) => x.sequence - y.sequence));
  assert.equal(one.authorId, f.owner.id);
  assert.equal(two.authorId, f.writer.id);
  const canonical = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${one.conversationId}`), 200) as Conversation;
  assert.deepEqual(canonical.messages, discussion.messages);
  assert.equal(canonical.createdBy, first.authorId);
  const third = expectStatus(await f.writer.browser.request('POST', `/api/v1/conversations/${one.conversationId}/messages`, {
    body: { body: 'Reply through the existing conversation entry point.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  assert.equal(third.sequence, 3);
  assert.equal((await f.read()).messages[2]!.id, third.id);
  assert.deepEqual(await f.counts(), { bindings: 1, messages: 3, conversations: 1, events: before.events + 3 });
});

test('bounded newest/older windows retain the exact first root and never rewrite its identity', async () => {
  const f = await scene();
  const sent: ConversationMessage[] = [];
  for (let i = 0; i < 4; i++) sent.push(expectStatus(await f.writer.browser.request('POST', f.path, {
    body: { body: `Actual contribution ${i + 1}`, clientMessageId: randomUUID() },
  }), 201) as ConversationMessage);
  const before = await f.counts();
  const newest = await f.read('?limit=1');
  assert.deepEqual(newest.root, sent[0]);
  assert.deepEqual(newest.messages, [sent[3]]);
  assert.deepEqual(newest.messagePage, { hasMoreBefore: true, nextBeforeSequence: 4, limit: 1 });
  const older = await f.read('?limit=2&beforeSequence=4');
  assert.deepEqual(older.root, sent[0]);
  assert.deepEqual(older.messages, sent.slice(1, 3));
  assert.equal(older.messagePage.nextBeforeSequence, 2);
  const oldest = await f.read('?limit=1&beforeSequence=2');
  assert.deepEqual(oldest.messages, [sent[0]]);
  assert.equal(oldest.messagePage.hasMoreBefore, false);
  assert.deepEqual(await f.counts(), before);
});

test('durable task retries recheck access and conflict on changed payload, task or generic thread operation', async () => {
  const f = await scene();
  const command = { body: 'Keep a lost-response retry exact.', clientMessageId: randomUUID() };
  const sent = expectStatus(await f.writer.browser.request('POST', f.path, { body: command }), 201) as ConversationMessage;
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', f.path, { body: command }), 201), sent);
  await assert.rejects(taskDiscussionUseCases(db).contribute({ kind: 'human', id: f.writer.id }, f.task.id,
    { ...command, body: 'Changed intent' }), ConflictError);
  const other = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, {
    body: { title: 'Another task', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  assert.equal((await f.writer.browser.request('POST', `/api/v1/work/${other.id}/discussion`, { body: command })).status, 409);
  assert.equal((await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: command })).status, 409);
  assert.equal((await f.reader.browser.request('POST', f.path, { body: command })).status, 403);
  assert.equal((await f.outsider.browser.request('GET', f.path)).status, 404);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  assert.equal((await f.writer.browser.request('POST', f.path, { body: command })).status, 404);
  assert.equal((await f.writer.browser.request('GET', f.path)).status, 404);
  assert.equal((await f.read()).messages.length, 1);
  assert.equal((await f.counts()).bindings, 1);
});

test('current material citations are exact; restricted or invalid first sends leave no synthetic thread', async () => {
  const f = await scene();
  const elsewhere = await project(f.owner, f.ws.id, 'Other restricted sources', 'restricted');
  const material = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/materials`, {
    body: { title: 'Private source', body: 'Do not cross the project ceiling.', clientMutationId: randomUUID() },
  }), 201) as Material;
  const before = await f.counts();
  assert.equal((await f.writer.browser.request('POST', f.path, { body: { body: 'Invalid cited contribution',
    clientMessageId: randomUUID(), source: { materialId: material.materialId, version: 1 } } })).status, 404);
  assert.equal((await f.writer.browser.request('POST', f.path, { body: { body: '  ', clientMessageId: randomUUID() } })).status, 400);
  assert.deepEqual(await f.counts(), before);
  const own = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/materials`, {
    body: { title: 'Authorized source', body: 'Actual visible trial.', clientMutationId: randomUUID() },
  }), 201) as Material;
  const sent = expectStatus(await f.writer.browser.request('POST', f.path, { body: { body: 'The measured first contribution.',
    clientMessageId: randomUUID(), source: { materialId: own.materialId, version: own.version } } }), 201) as ConversationMessage;
  assert.deepEqual((await f.read()).root, sent);
  assert.deepEqual(sent.source, { materialId: own.materialId, version: 1 });
});

test('failure after first root binding rolls back conversation, message, binding and event; exact retry creates once', async () => {
  const f = await scene();
  const before = await f.counts();
  const unit = taskDiscussionUnitOfWork(db);
  const injected = createTaskDiscussionUseCases({ run: (action) => unit.run((ports) => action({ ...ports, discussion: {
    ...ports.discussion, async bind(input) {
      await ports.discussion.bind(input);
      throw new Error('injected failure after genuine root binding');
    },
  } })) });
  const actor = { kind: 'human' as const, id: f.writer.id };
  const command = { body: 'Recover the same private draft.', clientMessageId: randomUUID() };
  await assert.rejects(injected.contribute(actor, f.task.id, command), /injected failure/);
  assert.deepEqual(await f.counts(), before);
  assert.equal((await f.read()).root, null);
  const sent = await taskDiscussionUseCases(db).contribute(actor, f.task.id, command);
  assert.deepEqual(await taskDiscussionUseCases(db).contribute(actor, f.task.id, command), sent);
  assert.deepEqual(await f.counts(), { bindings: 1, messages: 1, conversations: 1, events: before.events + 1 });
});
