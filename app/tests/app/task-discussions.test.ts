import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { notificationFactRows, personalRunRows, projectExportRows, schema } from '@flux/db';
import { candidatesFor, ConflictError, createTaskDiscussionUseCases, InvalidInputError, NotFoundError } from '@flux/core';
import type { GeneratorEvent } from '@flux/core';
import { projectExportPath, type Conversation, type ConversationMessage, type Material, type Page,
  type ConversationSummary, type ProjectExport, type ReturnSummary, type SearchResponse, type TaskDiscussion, type WorkItem } from '@flux/contracts';
import { taskDiscussionInTransaction, taskDiscussionUnitOfWork, taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, settled, waitUntilBlockedBy } from './support/locks.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { transactionEventSession } from '../../apps/server/src/work/transaction-events.js';
import { guardFinalEventPhase } from './support/final-events.js';
import { db, pool } from './support/db.js';

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
  // Every conversation window carries its current binding, even when the genuine root is outside it.
  for (const query of ['', '?limit=1', '?limit=1&beforeSequence=4']) {
    const conversation = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${sent[0]!.conversationId}${query}`), 200) as Conversation;
    assert.deepEqual(conversation.task, { workId: f.task.id, title: f.task.title });
    if (query) assert.equal(conversation.messages.some((message) => message.sequence === 1), false);
  }
  assert.deepEqual(await f.counts(), before);
});

test('conversation task binding is current, absent on ordinary threads, read-only and inaccessible after revocation', async () => {
  const f = await scene();
  const root = expectStatus(await f.writer.browser.request('POST', f.path, {
    body: { body: 'The task has a genuine root.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  const ordinary = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, {
    body: { body: 'Independent conversation.', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  await db.update(schema.projectWorkItems).set({ title: 'Current renamed task' }).where(eq(schema.projectWorkItems.id, f.task.id));
  const before = await f.counts();
  const read = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${root.conversationId}`), 200) as Conversation;
  assert.deepEqual(read.task, { workId: f.task.id, title: 'Current renamed task' });
  const nonTask = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${ordinary.id}`), 200) as Conversation;
  assert.equal(Object.hasOwn(nonTask, 'task'), false);
  assert.deepEqual(await f.counts(), before);
  await grant(f.owner, f.place.id, f.reader, 'denied');
  const afterRevocation = await f.counts();
  const revoked = await f.reader.browser.request('GET', `/api/v1/conversations/${root.conversationId}`);
  const unknown = await f.reader.browser.request('GET', `/api/v1/conversations/${randomUUID()}`);
  assert.equal(revoked.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await f.counts(), afterRevocation);
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

async function agentIn(f: Awaited<ReturnType<typeof scene>>) {
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, {
    body: { name: 'Trial analyst', owner: 'self' },
  }), 201) as { id: string; name: string };
  const grant = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201) as { id: string };
  return { agent, grant, principal: { kind: 'agent' as const, id: agent.id } };
}

test('a genuine agent creates the canonical root; human and agent command identities remain distinct', async () => {
  const f = await scene();
  const { agent, principal } = await agentIn(f);
  const command = { body: 'Measured the actual trial.', clientMessageId: randomUUID() };
  const root = await taskDiscussionUseCases(db).contribute(principal, f.task.id, command);
  assert.equal(root.authorId, null);
  assert.deepEqual(root.author, { kind: 'agent', id: agent.id, name: 'Trial analyst' });
  const sharedId = randomUUID();
  const [human, second] = await Promise.all([
    f.writer.browser.request('POST', f.path, { body: { body: 'A human counterexample.', clientMessageId: sharedId } }),
    taskDiscussionUseCases(db).contribute(principal, f.task.id, { body: 'An agent counterexample.', clientMessageId: sharedId }),
  ]);
  const written = expectStatus(human, 201) as ConversationMessage;
  assert.notEqual(written.id, second.id);
  assert.equal(written.authorId, f.writer.id);
  assert.equal(Object.hasOwn(written, 'author'), false, 'existing human JSON remains exact');
  assert.deepEqual([written.sequence, second.sequence].sort(), [2, 3]);
  assert.deepEqual(await taskDiscussionUseCases(db).contribute({ ...principal, id: principal.id.toUpperCase() }, f.task.id,
    { ...command, clientMessageId: command.clientMessageId.toUpperCase() }), root);
  await assert.rejects(taskDiscussionUseCases(db).contribute(principal, f.task.id,
    { ...command, body: 'Changed intent' }), ConflictError);
  const discussion = await f.read('?limit=1');
  assert.deepEqual(discussion.root, root, 'the agent root remains outside the newest bounded window');
  const canonical = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${root.conversationId}`), 200) as Conversation;
  assert.equal(canonical.createdBy, null);
  assert.deepEqual(canonical.createdByActor, root.author);
  assert.deepEqual(canonical.messages.map((row) => row.id), [root.id, ...[written, second].sort((a, b) => a.sequence - b.sequence).map((row) => row.id)]);
  const listed = expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/conversations`), 200) as Page<ConversationSummary>;
  assert.deepEqual(listed.items[0]!.createdByActor, root.author);
  assert.equal((await f.writer.browser.request('POST', f.path, { body: { ...command,
    author: { kind: 'agent', id: agent.id }, authorId: null } })).status, 400, 'human HTTP cannot nominate an agent');
  const stored = (await pool.query('SELECT author_id,author_agent_id,created_at FROM project_messages WHERE id=$1', [root.id])).rows[0]!;
  assert.equal(stored.author_id, null);
  assert.equal(stored.author_agent_id, agent.id);
  assert.equal(stored.created_at.toISOString(), root.createdAt);
  assert.equal((await f.counts()).bindings, 1);
});

test('simultaneous first human/two-agent sends keep one root and kind-scoped receipts even for a colliding textual ID', async () => {
  const f = await scene();
  const { principal: second } = await agentIn(f);
  // Deliberately construct the rare UUID collision; this is a stored actor fixture,
  // not an external client activation or a way for callers to select authorship.
  await pool.query('INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,$3,$4,$4)',
    [f.writer.id, f.ws.id, 'root-writer', f.owner.id]);
  const collision = { kind: 'agent' as const, id: f.writer.id };
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, {
    body: { principal: collision, role: 'contributor' },
  }), 201);
  const clientMessageId = randomUUID();
  const humanCommand = { body: 'A human first contribution.', clientMessageId };
  const agentCommand = { body: 'A distinct agent first contribution.', clientMessageId };
  const otherCommand = { body: 'Another agent first contribution.', clientMessageId };
  const [human, agent, other] = await Promise.all([
    f.writer.browser.request('POST', f.path, { body: humanCommand }).then((response) => expectStatus(response, 201) as ConversationMessage),
    taskDiscussionUseCases(db).contribute(collision, f.task.id, agentCommand),
    taskDiscussionUseCases(db).contribute(second, f.task.id, otherCommand),
  ]);
  assert.equal(human.authorId, f.writer.id);
  assert.equal(agent.authorId, null);
  assert.equal(agent.author?.id, f.writer.id);
  assert.deepEqual([human.sequence, agent.sequence, other.sequence].sort(), [1, 2, 3]);
  assert.equal(new Set([human.conversationId, agent.conversationId, other.conversationId]).size, 1);
  assert.equal(new Set([human.id, agent.id, other.id]).size, 3);
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', f.path, { body: humanCommand }), 201), human);
  assert.deepEqual(await taskDiscussionUseCases(db).contribute(collision, f.task.id, agentCommand), agent);
  assert.deepEqual(await taskDiscussionUseCases(db).contribute(second, f.task.id, otherCommand), other);
  const first = [human, agent, other].find((row) => row.sequence === 1)!;
  const discussion = await f.read();
  assert.deepEqual(discussion.root, first);
  assert.equal(discussion.messages.length, 3);
  assert.equal((await f.counts()).bindings, 1);
});

test('real agent history reaches bounded helper context, search, export, notifications and return summaries', async () => {
  const f = await scene();
  const { agent, principal } = await agentIn(f);
  const root = expectStatus(await f.writer.browser.request('POST', f.path, {
    body: { body: 'Human trial question.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  const previous = expectStatus(await f.writer.browser.request('GET', `/api/v1/return?place=project&id=${f.place.id}`), 200) as ReturnSummary;
  expectStatus(await f.writer.browser.request('PUT', '/api/v1/return-points', {
    body: { place: { type: 'project', id: f.place.id }, mark: previous.mark },
  }), 200);
  const reply = await taskDiscussionUseCases(db).contribute(principal, f.task.id,
    { body: 'Can you verify the spectrometer trial?', clientMessageId: randomUUID() });
  const context = await personalRunRows(db).messages(root.conversationId, 2);
  assert.deepEqual(context.map((row) => [row.id, row.author.kind, row.author.id]),
    [[root.id, 'human', f.writer.id], [reply.id, 'agent', agent.id]]);
  assert.equal(context[1]!.authorName, 'Trial analyst');
  assert.deepEqual((await personalRunRows(db).messages(root.conversationId, 1)).map((row) => row.id), [reply.id],
    'bounded context does not silently drop agent rows and replace them with older humans');
  const query = new URLSearchParams({ q: 'spectrometer', type: 'message', place: `project:${f.place.id}`, author: `agent:${agent.id}` });
  const found = expectStatus(await f.reader.browser.request('GET', `/api/v1/search?${query}`), 200) as SearchResponse;
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0]!.author, 'Trial analyst (agent)');
  assert.deepEqual(found.items[0]!.target, { type: 'message', projectId: f.place.id, conversationId: root.conversationId, messageId: reply.id });
  const exported = await projectExportRows(db).conversations(f.place.id);
  assert.deepEqual(exported[0]!.messages.map((row) => row.author), [{ kind: 'human', id: f.writer.id }, principal]);
  const document = expectStatus(await f.owner.browser.request('GET', projectExportPath(f.place.id)), 200) as ProjectExport;
  assert.deepEqual(document.conversations[0]!.messages[1]!.author, principal);
  const facts = notificationFactRows(db);
  const message = (await facts.projectMessage(reply.id))!;
  assert.deepEqual(message.author, principal);
  assert.deepEqual(message.earlierAuthors, [f.writer.id]);
  const event = (await pool.query(`SELECT id,seq,kind,workspace_id AS "workspaceId",object_id AS "objectId",actor_id AS "actorId",data
    FROM events WHERE data->>'messageId'=$1`, [reply.id])).rows[0] as GeneratorEvent;
  assert.equal(event.actorId, `agent:${agent.id}`);
  const candidates = await candidatesFor(event, facts);
  assert.deepEqual(candidates.map((row) => row.userId), [f.writer.id]);
  assert.match(candidates[0]!.title, /Trial analyst \(agent\)/);
  const back = expectStatus(await f.writer.browser.request('GET', `/api/v1/return?place=project&id=${f.place.id}`), 200) as ReturnSummary;
  assert.ok(back.items.some((item) => item.kind === 'question' && item.text.includes('Trial analyst') && item.source.type === 'message' && item.source.messageId === reply.id));
  const digest = expectStatus(await f.writer.browser.request('GET', `/api/v1/return?place=project&id=${f.place.id}&digest=1`), 200) as ReturnSummary;
  assert.ok(digest.digest!.conversations.some((item) => item.quotes.some((quote) => quote.messageId === reply.id && quote.author === 'Trial analyst (agent)')));
  assert.equal(JSON.stringify(back).includes(f.owner.id), false, 'agent owner is not fabricated as the author');
});

test('agent first-send rollback is atomic; current grant revocation blocks retries while genuine history stays readable', async () => {
  const f = await scene();
  const { agent, principal, grant: access } = await agentIn(f);
  const before = await f.counts();
  const command = { body: 'Actual agent contribution.', clientMessageId: randomUUID() };
  const unit = taskDiscussionUnitOfWork(db);
  const injected = createTaskDiscussionUseCases({ run: (action) => unit.run((ports) => action({ ...ports, discussion: {
    ...ports.discussion, async bind(input) { await ports.discussion.bind(input); throw new Error('agent binding rollback'); },
  } })) });
  await assert.rejects(injected.contribute(principal, f.task.id, command), /agent binding rollback/);
  assert.deepEqual(await f.counts(), before);
  const root = await taskDiscussionUseCases(db).contribute(principal, f.task.id, command);
  const old = (await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0];
  const other = await workspace(f.owner, 'Another actor workspace');
  const foreign = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${other.id}/agents`, {
    body: { name: 'Foreign analyst', owner: 'self' },
  }), 201) as { id: string };
  await assert.rejects(pool.query('UPDATE project_messages SET author_agent_id=$2 WHERE id=$1', [root.id, foreign.id]), /foreign key constraint/);
  await assert.rejects(pool.query('UPDATE project_messages SET author_id=$2 WHERE id=$1', [root.id, f.owner.id]), /check constraint/);
  expectStatus(await f.owner.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${access.id}`), 204);
  await assert.rejects(taskDiscussionUseCases(db).contribute(principal, f.task.id, command), NotFoundError);
  await assert.rejects(taskDiscussionUseCases(db).contribute(principal, f.task.id,
    { ...command, clientMessageId: randomUUID() }), NotFoundError);
  assert.deepEqual((await f.read()).root, root);
  assert.deepEqual((await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0], old);
  await assert.rejects(pool.query('DELETE FROM agents WHERE id=$1', [agent.id]), /foreign key constraint/,
    'recorded authors cannot be deleted out of genuine history');
  assert.deepEqual(await f.counts(), { bindings: 1, messages: 1, conversations: 1, events: before.events + 2 });
});

test('co-work composition rolls back actual agent contribution before and after its final event flush', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const before = await f.counts();
  const related = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM search_documents WHERE project_id=$1 AND kind='message') AS search,
    (SELECT count(*)::int FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.object_id=$1) AS outbox`, [f.place.id])).rows[0];
  const relatedBefore = await related();
  const command = { body: 'Actual checkpoint contribution.', clientMessageId: randomUUID() };
  for (const phase of ['before', 'after']) {
    await assert.rejects(db.transaction(async (tx) => {
      const session = taskDiscussionInTransaction(tx);
      const contribution = await session.contribute(principal, f.task.id, command);
      assert.equal(contribution.authorId, null);
      assert.equal(session.eventIntents[0]!.data.messageId, contribution.id);
      if (phase === 'after') await session.flushEvents();
      // Actual153 durable request/receipt/lease integration remains separate.
      throw new Error(`outer control resolution failed ${phase} final events`);
    }), /outer control resolution failed/);
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(await related(), relatedBefore);
    assert.equal((await f.read()).root, null);
  }
  const sent = await db.transaction(async (tx) => {
    const session = taskDiscussionInTransaction(tx);
    const contribution = await session.contribute(principal, f.task.id, command);
    await session.flushEvents();
    return contribution;
  });
  assert.deepEqual(await taskDiscussionUseCases(db).contribute(principal, f.task.id, command), sent);
  assert.deepEqual(await f.counts(), { bindings: 1, messages: 1, conversations: 1, events: before.events + 1 });
});

test('two genuine contributions defer every audience until final state and take the stream lock only during one final flush', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const before = await f.counts();
  const commands = [
    { body: 'The first actual checkpoint.', clientMessageId: randomUUID() },
    { body: 'The second actual checkpoint.', clientMessageId: randomUUID() },
  ];
  const sent = await db.transaction(async (tx) => {
    let eventInsertStarted = false;
    // Use the real transaction, but fail if any audience SELECT follows the first event.
    const checked = new Proxy(tx, { get(target, property) {
      if (property === 'select' || property === 'selectDistinct') return (...args: unknown[]) => {
        assert.equal(eventInsertStarted, false, 'all policy/audience reads precede the first event insert');
        return Reflect.apply(Reflect.get(target, property), target, args);
      };
      if (property === 'insert') return (table: unknown) => {
        if (table === schema.events) eventInsertStarted = true;
        return Reflect.apply(target.insert, target, [table]);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const session = taskDiscussionInTransaction(checked);
    const first = session.contribute(principal, f.task.id, commands[0]!);
    assert.throws(() => session.flushEvents(), /Await all native commands/);
    const root = await first;
    const reply = await session.contribute(principal, f.task.id, commands[1]!);
    const intents = session.eventIntents;
    assert.deepEqual(intents.map((intent) => intent.data.messageId), [root.id, reply.id]);
    assert.ok(Object.isFrozen(intents) && intents.every((intent) => Object.isFrozen(intent)
      && Object.isFrozen(intent.principal) && Object.isFrozen(intent.data)));
    const staged = await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM events WHERE object_id=${f.place.id}) AS events,
      EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND classid=((hashtext('flux.events.seq')::bigint >> 32) & 4294967295)::oid
        AND objid=(hashtext('flux.events.seq')::bigint & 4294967295)::oid AND objsubid=1) AS stream_lock`);
    assert.deepEqual(staged.rows[0], { events: before.events, stream_lock: false });
    // A caller-owned authorization change/coordination write precedes the event phase.
    await tx.delete(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, f.place.id),
      eq(schema.projectGrants.userId, f.reader.id)));
    const flush = session.flushEvents();
    assert.equal(session.flushEvents(), flush);
    const eventIds = await flush;
    assert.equal(eventIds.length, 2);
    assert.equal(eventInsertStarted, true);
    await assert.rejects(session.contribute(principal, f.task.id, commands[0]!), /session is closed/);
    await assert.rejects(session.getDiscussion(principal, f.task.id), /session is closed/);
    return { root, reply, eventIds };
  });
  assert.deepEqual([sent.root.sequence, sent.reply.sequence], [1, 2]);
  const audiences = (await pool.query('SELECT event_id,recipient FROM event_audience WHERE event_id=ANY($1::uuid[])', [sent.eventIds])).rows;
  for (const eventId of sent.eventIds) {
    assert.ok(audiences.some((row) => row.event_id === eventId && row.recipient === `human:${f.owner.id}`));
    assert.equal(audiences.some((row) => row.event_id === eventId && row.recipient === `human:${f.reader.id}`), false);
  }
  await db.transaction(async (tx) => {
    const session = taskDiscussionInTransaction(tx);
    assert.deepEqual(await session.contribute(principal, f.task.id, commands[0]!), sent.root);
    assert.deepEqual(session.eventIntents, []);
    assert.deepEqual(await session.flushEvents(), []);
  });
  assert.deepEqual(await f.counts(), { bindings: 1, messages: 2, conversations: 1, events: before.events + 2 });
});

test('native work, canonical result and a genuine agent root share the caller transaction and one final audience batch', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const owner = { kind: 'human' as const, id: f.owner.id };
  const committed = await db.transaction(async (tx) => {
    const guarded = guardFinalEventPhase(tx);
    const session = nativeWorkInTransaction(guarded.tx);
    const creating = session.createWork(owner, f.place.id, { title: 'A bounded measurement', clientCommandId: randomUUID() });
    assert.throws(() => session.flushEvents(), /Await all native commands/);
    const work = await creating;
    const root = await session.contribute(principal, work.id, { body: 'The real agent records the measurement.', clientMessageId: randomUUID() });
    const result = await session.createResult(owner, f.place.id, { title: 'Measurement preserved', finding: 'positive',
      evidence: 'A recorded actual result', work: [work.id] });
    await session.updateWork(owner, work.id, { outcome: 'Final state before receipt and events' }, work.version);
    assert.equal((await session.getWork(owner, work.id)).outcome, 'Final state before receipt and events');
    assert.equal((await session.getDiscussion(owner, work.id)).rootMessageId, root.id);
    // The result reports on the task, so it also contributes one message to the task's existing thread.
    assert.deepEqual(session.eventIntents.map((item) => item.kind), ['project.work_created.v1',
      'project.conversation_created.v1', 'project.result_recorded.v1', 'project.message_sent.v1', 'project.work_updated.v1']);
    const state = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND classid=((hashtext('flux.events.seq')::bigint >> 32) & 4294967295)::oid
        AND objid=(hashtext('flux.events.seq')::bigint & 4294967295)::oid AND objsubid=1) AS stream_lock`);
    assert.equal(state.rows[0]!.stream_lock, false);
    // This is an actual final domain/audience change, not a simulated152/153 receipt.
    await tx.delete(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, f.place.id), eq(schema.projectGrants.userId, f.reader.id)));
    const flush = session.flushEvents();
    assert.equal(session.flushEvents(), flush);
    const events = await flush;
    assert.equal(guarded.started, true);
    await assert.rejects(session.getWork(owner, work.id), /session is closed/);
    await assert.rejects(session.contribute(principal, work.id, { body: 'Too late', clientMessageId: randomUUID() }), /session is closed/);
    return { work, root, result, events };
  });
  assert.equal(committed.events.length, 5);
  const rows = (await pool.query('SELECT event_id,recipient FROM event_audience WHERE event_id=ANY($1::uuid[])', [committed.events])).rows;
  for (const event of committed.events) {
    assert.ok(rows.some((row) => row.event_id === event && row.recipient === `human:${f.owner.id}`));
    assert.equal(rows.some((row) => row.event_id === event && row.recipient === `human:${f.reader.id}`), false);
  }
  assert.deepEqual((await pool.query('SELECT created_by_kind,created_by_id FROM project_results WHERE id=$1', [committed.result.id])).rows[0],
    { created_by_kind: 'human', created_by_id: f.owner.id });
  assert.equal((await taskDiscussionUseCases(db).getDiscussion(owner, committed.work.id)).rootMessageId, committed.root.id);
  await db.transaction(async (tx) => {
    const session = nativeWorkInTransaction(tx);
    await session.getWork(owner, committed.work.id);
    await session.getDiscussion(owner, committed.work.id);
    assert.deepEqual(session.eventIntents, []);
    assert.deepEqual(await session.flushEvents(), []);
  });
});

test('native preparation and final events roll back together before or after flush, including actual final domain changes', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const owner = { kind: 'human' as const, id: f.owner.id };
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_work_items WHERE project_id=$1) AS work,
    (SELECT count(*)::int FROM project_task_notices WHERE project_id=$1) AS notices,
    (SELECT count(*)::int FROM project_results WHERE project_id=$1) AS results,
    (SELECT count(*)::int FROM project_object_links WHERE project_id=$1) AS links,
    (SELECT count(*)::int FROM search_documents WHERE project_id=$1) AS search,
    (SELECT count(*)::int FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.object_id=$1) AS outbox`, [f.place.id])).rows[0];
  const before = await counts();
  const discussions = await f.counts();
  const creation = { title: 'Atomic new task', clientCommandId: randomUUID() };
  for (const phase of ['before', 'after']) {
    await assert.rejects(db.transaction(async (tx) => {
      const session = nativeWorkInTransaction(tx);
      const work = await session.createWork(owner, f.place.id, creation);
      await session.contribute(principal, work.id, { body: 'Actual agent text', clientMessageId: randomUUID() });
      await session.createResult(owner, f.place.id, { title: 'Atomic finding', finding: 'negative', work: [work.id] });
      await session.updateWork(owner, f.task.id, { outcome: 'Final domain marker' }, f.task.version);
      if (phase === 'after') await session.flushEvents();
      throw new Error(`outer native failure ${phase} events`);
    }), /outer native failure/);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(await f.counts(), discussions);
    assert.deepEqual((await pool.query('SELECT outcome,version FROM project_work_items WHERE id=$1', [f.task.id])).rows[0],
      { outcome: f.task.outcome, version: f.task.version });
  }
});

test('the shared event collector snapshots nested canonical data and rejects early or late preparation', async () => {
  const f = await scene();
  await db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const data = { workId: f.task.id, reference: { ids: [f.task.id] } };
    const principal = { kind: 'human' as const, id: f.owner.id };
    await session.record(principal, f.ws.id, 'project.work_updated.v1', f.place.id, data);
    data.reference.ids[0] = randomUUID();
    principal.id = f.reader.id;
    const intent = session.eventIntents[0]!;
    assert.equal(intent.principal.id, f.owner.id);
    const reference = intent.data.reference as { ids: string[] };
    assert.deepEqual(reference.ids, [f.task.id]);
    assert.ok(Object.isFrozen(reference) && Object.isFrozen(reference.ids));
    assert.throws(() => reference.ids.push(randomUUID()), TypeError);
    let finish!: () => void;
    const command = session.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    assert.throws(() => session.flushEvents(), /Await all native commands/);
    finish();
    await command;
    const flush = session.flushEvents();
    assert.equal(session.flushEvents(), flush);
    await flush;
    await assert.rejects(session.run(async () => undefined), /session is closed/);
    await assert.rejects(session.record(principal, f.ws.id, 'project.work_updated.v1', f.place.id, data), /session is closed/);
  });
});

const declaredKeys = ['conversationId', 'messagePage', 'messages', 'projectId', 'root', 'rootMessageId', 'workId', 'workspaceId'];
const human = (who: Person) => ({ kind: 'human' as const, id: who.id });
/** The task discussion counts plus every other row a read must never create. */
async function rowsOf(f: Awaited<ReturnType<typeof scene>>) {
  return { ...await f.counts(), ...(await pool.query(`SELECT
    (SELECT count(*)::int FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.object_id=$1) AS outbox,
    (SELECT count(*)::int FROM search_documents WHERE project_id=$1) AS search,
    (SELECT count(*)::int FROM project_task_notices WHERE project_id=$1) AS notices,
    (SELECT count(*)::int FROM project_work_items WHERE project_id=$1) AS work`, [f.place.id])).rows[0] };
}
const rootIdentity = (f: Awaited<ReturnType<typeof scene>>, sent: ConversationMessage) => ({ workId: f.task.id,
  workspaceId: f.ws.id, projectId: f.place.id, conversationId: sent.conversationId, rootMessageId: sent.id });

test('a task in a hidden project is indistinguishable from an unknown task, including its error code', async () => {
  const f = await scene();
  const stranger = await person('root-stranger');
  const open = await project(f.owner, f.ws.id, 'Workspace-visible discussion', 'workspace');
  const visibleTask = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${open.id}/work`, {
    body: { title: 'Visible to members', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const denied = await person('root-denied');
  await addMember(f.owner, f.ws.id, denied, 'member');
  await grant(f.owner, open.id, denied, 'denied');
  const before = await rowsOf(f);
  const use = taskDiscussionUseCases(db);
  const unknown = randomUUID();
  const cases: Array<[string, Person, string]> = [['restricted project, member without a grant', f.outsider, f.task.id],
    ['restricted project, not a workspace member', stranger, f.task.id], ['denied grant on a visible project', denied, visibleTask.id]];
  for (const [label, who, workId] of cases) {
    const missing = await who.browser.request('GET', `/api/v1/work/${unknown}/discussion`);
    assert.equal(missing.status, 404, label);
    assert.equal((missing.json as { code: string }).code, 'WORK_NOT_FOUND', label);
    const read = await who.browser.request('GET', `/api/v1/work/${workId}/discussion`);
    assert.equal(read.status, missing.status, label);
    assert.deepEqual(read.json, missing.json, `${label}: the read body must not reveal that the task exists`);
    const body = { body: 'A contribution that must not be admitted.', clientMessageId: randomUUID() };
    const write = await who.browser.request('POST', `/api/v1/work/${workId}/discussion`, { body });
    const writeMissing = await who.browser.request('POST', `/api/v1/work/${unknown}/discussion`, { body });
    assert.equal(write.status, writeMissing.status, label);
    assert.deepEqual(write.json, writeMissing.json, `${label}: the write body must not reveal that the task exists`);
    assert.equal((write.json as { code: string }).code, 'WORK_NOT_FOUND', label);
    for (const operate of [(id: string) => use.getDiscussion(human(who), id), (id: string) => use.getDiscussionRoot(human(who), id),
      (id: string) => use.contribute(human(who), id, body)]) {
      const hiddenError = await operate(workId).then(() => assert.fail('expected rejection'), (error: unknown) => error);
      const unknownError = await operate(unknown).then(() => assert.fail('expected rejection'), (error: unknown) => error);
      assert.ok(hiddenError instanceof NotFoundError && unknownError instanceof NotFoundError, label);
      assert.deepEqual({ status: hiddenError.status, code: hiddenError.code, message: hiddenError.message },
        { status: 404, code: 'WORK_NOT_FOUND', message: 'Work item not found' }, label);
      assert.deepEqual({ status: unknownError.status, code: unknownError.code, message: unknownError.message },
        { status: hiddenError.status, code: hiddenError.code, message: hiddenError.message }, label);
    }
  }
  // A visible task the caller may not change stays an honest 403, not a 404.
  assert.equal((await f.reader.browser.request('POST', f.path, { body: { body: 'Viewer text', clientMessageId: randomUUID() } })).status, 403);
  assert.deepEqual(await rowsOf(f), before);
});

test('the discussion response has exactly the declared keys, unbound and bound', async () => {
  const f = await scene();
  const raw = async () => expectStatus(await f.reader.browser.request('GET', f.path), 200) as Record<string, unknown>;
  assert.deepEqual(Object.keys(await raw()).sort(), declaredKeys);
  const sent = expectStatus(await f.writer.browser.request('POST', f.path, {
    body: { body: 'The genuine first message.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  const bound = await raw();
  assert.deepEqual(Object.keys(bound).sort(), declaredKeys, 'the stored binding row must not be spread into the response');
  assert.equal(Object.hasOwn(bound, 'rootSequence'), false);
  assert.deepEqual(Object.keys(await taskDiscussionUseCases(db).getDiscussion(human(f.reader), f.task.id)).sort(), declaredKeys);
  assert.equal(bound.rootMessageId, sent.id);
  assert.equal(bound.conversationId, sent.conversationId);
});

test('getDiscussionRoot is a pure read: null while unbound, then exactly the identity contribute returned', async () => {
  const f = await scene();
  const { principal: agent } = await agentIn(f);
  const use = taskDiscussionUseCases(db);
  const before = await rowsOf(f);
  for (const who of [human(f.owner), human(f.writer), human(f.reader), agent])
    for (let i = 0; i < 3; i++) assert.equal(await use.getDiscussionRoot(who, f.task.id), null);
  assert.equal(await use.getDiscussionRoot(human(f.owner), f.task.id.toUpperCase()), null);
  assert.deepEqual(await rowsOf(f), before, 'no binding, message, conversation, event, outbox, search or work row appeared');
  const root = await use.contribute(human(f.writer), f.task.id, { body: 'The genuine first message.', clientMessageId: randomUUID() });
  const reply = await use.contribute(agent, f.task.id, { body: 'A genuine agent reply.', clientMessageId: randomUUID() });
  const expected = rootIdentity(f, root);
  assert.equal(reply.conversationId, root.conversationId);
  const bound = await rowsOf(f);
  for (const who of [human(f.owner), human(f.writer), human(f.reader), agent]) {
    for (let i = 0; i < 3; i++) assert.deepEqual(await use.getDiscussionRoot(who, f.task.id), expected, 'a later reply never moves the root');
    assert.deepEqual(await use.getDiscussionRoot(who, f.task.id.toUpperCase()), expected);
  }
  const discussion = await f.read();
  assert.deepEqual({ workId: discussion.workId, workspaceId: discussion.workspaceId, projectId: discussion.projectId,
    conversationId: discussion.conversationId, rootMessageId: discussion.rootMessageId }, expected);
  assert.deepEqual(await rowsOf(f), bound);
  // An agent-authored root is identified the same way.
  const other = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, {
    body: { title: 'Agent opens this one', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  assert.equal(await use.getDiscussionRoot(agent, other.id), null);
  const agentRoot = await use.contribute(agent, other.id, { body: 'Measured the actual trial.', clientMessageId: randomUUID() });
  assert.deepEqual(await use.getDiscussionRoot(human(f.reader), other.id), { workId: other.id, workspaceId: f.ws.id,
    projectId: f.place.id, conversationId: agentRoot.conversationId, rootMessageId: agentRoot.id });
  await assert.rejects(use.getDiscussionRoot(human(f.owner), randomUUID()), (error) => error instanceof NotFoundError && error.code === 'WORK_NOT_FOUND');
  await assert.rejects(use.getDiscussionRoot(human(f.owner), 'not-a-task'), (error) => error instanceof InvalidInputError && error.status === 400);
});

test('getDiscussionRoot follows current policy: viewers and guests with access read it, denied people get the unknown-task 404', async () => {
  const f = await scene();
  const guest = await person('root-guest');
  await addMember(f.owner, f.ws.id, guest, 'guest');
  const use = taskDiscussionUseCases(db);
  const expected = rootIdentity(f, await use.contribute(human(f.writer), f.task.id,
    { body: 'The genuine first message.', clientMessageId: randomUUID() }));
  const rejected = (who: Person) => assert.rejects(use.getDiscussionRoot(human(who), f.task.id),
    (error) => error instanceof NotFoundError && error.status === 404 && error.code === 'WORK_NOT_FOUND');
  await rejected(guest);
  await grant(f.owner, f.place.id, guest, 'viewer');
  assert.deepEqual(await use.getDiscussionRoot(human(guest), f.task.id), expected);
  assert.deepEqual(await use.getDiscussionRoot(human(f.reader), f.task.id), expected);
  await rejected(f.outsider);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  await rejected(f.writer);
  await grant(f.owner, f.place.id, f.reader, 'denied');
  await rejected(f.reader);
  assert.deepEqual(await use.getDiscussionRoot(human(f.owner), f.task.id), expected);
});

test('getDiscussionRoot takes no access-row lock, while the window read waits for it', async () => {
  const f = await scene();
  const use = taskDiscussionUseCases(db);
  const root = await use.contribute(human(f.writer), f.task.id, { body: 'The genuine first message.', clientMessageId: randomUUID() });
  let waiting!: Promise<TaskDiscussion>;
  await db.transaction(async (tx) => {
    // The same project-row lock every grant change takes; FOR SHARE access reads must wait for it.
    await tx.execute(sql`SELECT 1 FROM projects WHERE id=${f.place.id} FOR UPDATE`);
    const holder = await backendPid(tx);
    const read = use.getDiscussionRoot(human(f.reader), f.task.id);
    const done = settled(read);
    await Promise.race([read.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.equal(done(), true, 'the lock-free root read must not wait for the access rows');
    assert.deepEqual(await read, rootIdentity(f, root));
    waiting = use.getDiscussion(human(f.reader), f.task.id);
    const blocked = settled(waiting);
    await waitUntilBlockedBy(pool, holder);
    assert.equal(blocked(), false);
  });
  assert.equal((await waiting).rootMessageId, root.id);
});

test('getDiscussionRoot in a caller transaction queues no event, flushes nothing and is rejected after the final flush', async () => {
  const f = await scene();
  const use = taskDiscussionUseCases(db);
  const root = await use.contribute(human(f.writer), f.task.id, { body: 'The genuine first message.', clientMessageId: randomUUID() });
  const unbound = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, {
    body: { title: 'Still without a conversation', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const before = await rowsOf(f);
  const sessions = { taskDiscussionInTransaction, nativeWorkInTransaction };
  for (const [name, open] of Object.entries(sessions)) {
    await db.transaction(async (tx) => {
      const session = open(tx);
      assert.deepEqual(await session.getDiscussionRoot(human(f.reader), f.task.id), rootIdentity(f, root), name);
      assert.equal(await session.getDiscussionRoot(human(f.reader), unbound.id), null, name);
      await assert.rejects(session.getDiscussionRoot(human(f.outsider), f.task.id),
        (error) => error instanceof NotFoundError && error.code === 'WORK_NOT_FOUND', name);
      assert.deepEqual(session.eventIntents, [], `${name}: a pure read queues no event intent`);
      assert.deepEqual(await session.flushEvents(), [], name);
      await assert.rejects(session.getDiscussionRoot(human(f.reader), f.task.id), /session is closed/, name);
    });
  }
  assert.deepEqual(await rowsOf(f), before);
});
