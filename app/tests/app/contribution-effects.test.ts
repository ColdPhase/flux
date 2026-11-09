import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { schema, TASK_GRAPH_LOCK_NAMESPACE } from '@flux/db';
import { agentExecutionUseCases, createWorkContributions, createWorkUseCases, DomainError, type Principal, type WorkPorts } from '@flux/core';
import { createConnection } from './support/mcp-actions.js';
import type { AgentConnection, AgentExecutionCommand, AgentJsonValue, AgentPostcondition, Conversation, ConversationMessage,
  TaskDiscussion, WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction, policyWorkAccess, workRepository } from '../../apps/server/src/work/adapters.js';
import { taskDiscussionPorts, taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { transactionEventSession } from '../../apps/server/src/work/transaction-events.js';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { agentExecutionInTransaction } from '../../apps/server/src/agent-connection/execution.js';
import { addMember, expectStatus, grant, removeFromSpace, person, project, workspace, type Person } from './support/people.js';
import { backendPid, settled, waitUntilBlockedBy } from './support/locks.js';
import { guardFinalEventPhase } from './support/final-events.js';
import { db, pool } from './support/db.js';

// Explicit native contribution effects on the canonical task thread (#154): a saved blocker, the line saved at Done (what came of it, #868)
// and an explicit public handoff, each through the one canonical append, over real PostgreSQL and HTTP.

async function scene() {
  const [owner, writer, reader, outsider] = await Promise.all(['fx-owner', 'fx-writer', 'fx-reader', 'fx-outsider'].map(person));
  const ws = await workspace(owner, 'Contribution effects');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Effects trial', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'contributor');
  const task = async (title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title, clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_messages WHERE project_id=$1) AS messages,
    (SELECT count(*)::int FROM project_conversations WHERE project_id=$1) AS conversations,
    (SELECT count(*)::int FROM project_task_discussions WHERE project_id=$1) AS bindings,
    (SELECT count(*)::int FROM native_command_receipts WHERE project_id=$1) AS receipts,
    (SELECT count(*)::int FROM events WHERE object_id=$1) AS events,
    (SELECT count(*)::int FROM search_documents WHERE project_id=$1 AND kind='message') AS search,
    (SELECT count(*)::int FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.object_id=$1) AS outbox`, [place.id])).rows[0] as Record<string, number>;
  const discussion = async (who: Person, workId: string, query = '') =>
    expectStatus(await who.browser.request('GET', `/api/v1/work/${workId}/discussion${query}`), 200) as TaskDiscussion;
  const patch = (who: Person, workId: string, body: Record<string, unknown>, version: number) =>
    who.browser.request('PATCH', `/api/v1/work/${workId}`, { body, headers: { 'if-match': `"${version}"` } });
  /** Finishes the task with the one optional line of what came of it (#868). */
  const finish = (who: Person, workId: string, line: string, version: number, clientCommandId: string | null = randomUUID()) =>
    patch(who, workId, { status: 'done', cameOfIt: line, ...(clientCommandId ? { clientCommandId } : {}) }, version);
  const current = async (workId: string) => expectStatus(await owner.browser.request('GET', `/api/v1/work/${workId}`), 200) as WorkItem;
  return { owner, writer, reader, outsider, ws, place, task, counts, discussion, patch, finish, current };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const human = (who: Person): Principal => ({ kind: 'human', id: who.id });
const code = (response: { json: unknown }) => (response.json as { code: string }).code;
/** What moved between two snapshots; the outbox mirrors events and is compared whole where nothing may change. */
const delta = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(Object.keys(after).filter((key) => key !== 'outbox').map((key) => [key, after[key]! - before[key]!]));

async function agentIn(f: Scene, name = 'Trial analyst') {
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, {
    body: { name, owner: 'self' },
  }), 201) as { id: string };
  return { agent, principal: { kind: 'agent' as const, id: agent.id } };
}

test('an explicitly saved nonempty blocker contributes its exact text; clearing and status/owner/title changes contribute nothing', async () => {
  const f = await scene();
  const t = await f.task('Compare current measurements');
  const base = await f.counts();
  let item = expectStatus(await f.patch(f.writer, t.id, { status: 'blocked', clientCommandId: randomUUID() }, 1), 200) as WorkItem;
  item = expectStatus(await f.patch(f.writer, t.id, { owner: { kind: 'human', id: f.writer.id }, clientCommandId: randomUUID() }, item.version), 200) as WorkItem;
  item = expectStatus(await f.patch(f.writer, t.id, { title: 'Compare measurements', clientCommandId: randomUUID() }, item.version), 200) as WorkItem;
  assert.deepEqual(delta(await f.counts(), base), { messages: 0, conversations: 0, bindings: 0, receipts: 3, events: 3, search: 0 },
    'status, owner and title alone create no comment, no conversation and no binding');
  assert.equal((await f.discussion(f.reader, t.id)).root, null);

  const saveId = randomUUID();
  const intent = { blocker: '  Waiting for the hinge  ', clientCommandId: saveId };
  const quiet = await f.counts();
  const blocked = expectStatus(await f.patch(f.writer, t.id, intent, item.version), 200) as WorkItem;
  assert.equal(blocked.blocker, 'Waiting for the hinge');
  const read = await f.discussion(f.reader, t.id);
  assert.deepEqual([read.root?.body, read.root?.contribution, read.root?.authorId, read.root?.sequence],
    ['Waiting for the hinge', { kind: 'blocker' }, f.writer.id, 1]);
  assert.equal(read.rootMessageId, read.root!.id);
  assert.deepEqual(delta(await f.counts(), quiet), { messages: 1, conversations: 1, bindings: 1, receipts: 1, events: 2, search: 1 });
  const canonical = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${read.conversationId}`), 200) as Conversation;
  assert.deepEqual(canonical.messages, read.messages, 'the canonical conversation API shows the same contribution');
  assert.equal(canonical.firstMessageBody, 'Waiting for the hinge');

  // An exact stable retry returns the original outcome: no second message, event, receipt or version.
  const afterSave = await f.counts();
  assert.deepEqual(expectStatus(await f.patch(f.writer, t.id, intent, item.version), 200), blocked);
  assert.deepEqual(await f.counts(), afterSave);
  assert.equal((await f.current(t.id)).version, blocked.version);
  const changed = await f.patch(f.writer, t.id, { ...intent, blocker: 'A different reason' }, item.version);
  assert.deepEqual([changed.status, code(changed)], [409, 'IDEMPOTENCY_CONFLICT']);
  assert.deepEqual(await f.counts(), afterSave);

  // Clearing the blocker is not a comment.
  const cleared = expectStatus(await f.patch(f.writer, t.id, { blocker: null, clientCommandId: randomUUID() }, blocked.version), 200) as WorkItem;
  assert.equal(cleared.blocker, null);
  assert.equal((await f.counts()).messages, afterSave.messages);

  // A second explicit save is the next message of the same canonical thread.
  const secondId = randomUUID();
  const second = expectStatus(await f.patch(f.writer, t.id, { blocker: 'Second reason', clientCommandId: secondId }, cleared.version), 200) as WorkItem;
  const thread = await f.discussion(f.reader, t.id);
  assert.deepEqual(thread.messages.map((row) => [row.sequence, row.body, row.contribution]),
    [[1, 'Waiting for the hinge', { kind: 'blocker' }], [2, 'Second reason', { kind: 'blocker' }]]);
  assert.equal(thread.rootMessageId, read.rootMessageId, 'a later contribution never moves the root');

  // Changed produced work state is stale rather than overwritten or contributed twice; no key relies on the version fence.
  expectStatus(await f.patch(f.owner, t.id, { title: 'Someone else moved the task' }, second.version), 200);
  const beforeStale = await f.counts();
  const stale = await f.patch(f.writer, t.id, { blocker: 'Second reason', clientCommandId: secondId }, cleared.version);
  assert.deepEqual([stale.status, code(stale)], [409, 'COMMAND_POSTSTATE_STALE']);
  const fenced = await f.patch(f.writer, t.id, { blocker: 'Second reason' }, cleared.version);
  assert.deepEqual([fenced.status, code(fenced)], [409, 'VERSION_CONFLICT']);
  assert.deepEqual(await f.counts(), beforeStale);
  assert.equal((await f.discussion(f.reader, t.id)).messages.length, 2);

  // Ordinary human JSON keeps its exact shape: only the blocker messages carry a marker.
  const reply = expectStatus(await f.writer.browser.request('POST', `/api/v1/conversations/${read.conversationId}/messages`, {
    body: { body: 'A plain reply through the generic entry point.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  assert.equal(Object.hasOwn(reply, 'contribution'), false);
  assert.deepEqual((await f.discussion(f.reader, t.id)).messages.at(-1), reply);
});

test('blocker saves obey current access: outsiders see nothing, and nothing is contributed', async () => {
  const f = await scene();
  const t = await f.task('Guarded task');
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const before = await f.counts();
  assert.equal((await f.patch(f.outsider, t.id, { blocker: 'Hidden', clientCommandId: randomUUID() }, blocked.version)).status, 404);
  assert.equal((await f.patch(f.owner, t.id, { blocker: '   '.repeat(2), clientCommandId: randomUUID() }, blocked.version)).status, 200, 'a whitespace-only blocker is an empty clear');
  assert.equal((await f.counts()).messages, before.messages);
  await removeFromSpace(f.owner, f.place.id, f.writer);
  const denied = await f.patch(f.writer, t.id, { blocker: 'Revoked', clientCommandId: randomUUID() }, blocked.version + 1);
  assert.equal(denied.status, 404);
  assert.equal((await f.counts()).messages, before.messages);
});

test('the line saved at Done contributes one "what came of it" message to the finished task, bound or not', async () => {
  const f = await scene();
  const { principal: genuine, agent } = await agentIn(f);
  const [a, b, c, unrelated] = [await f.task('Task A'), await f.task('Task B'), await f.task('Task C'), await f.task('Unlinked task')];
  const use = taskDiscussionUseCases(db);
  const humanRoot = await use.contribute(human(f.owner), a.id, { body: 'A person opened this task thread.', clientMessageId: randomUUID() });
  const agentRoot = await use.contribute(genuine, b.id, { body: 'An agent opened this one.', clientMessageId: randomUUID() });
  const line = 'The hinge holds at 40 N';
  const commandIds = [randomUUID(), randomUUID(), randomUUID()];
  const base = await f.counts();
  // A thread opened by a person or an agent is the task's use, but the version the writer saw is the current one.
  const done = [expectStatus(await f.finish(f.writer, a.id, line, (await f.current(a.id)).version, commandIds[0]), 200) as WorkItem,
    expectStatus(await f.finish(f.writer, b.id, line, (await f.current(b.id)).version, commandIds[1]), 200) as WorkItem];
  assert.deepEqual(delta(await f.counts(), base), { messages: 2, conversations: 0, bindings: 0, receipts: 2, events: 4, search: 2 },
    'one message per finished task in its existing thread, and no new thread');
  const beforeNew = await f.counts();
  const fresh = expectStatus(await f.finish(f.writer, c.id, line, c.version, commandIds[2]), 200) as WorkItem;
  assert.deepEqual(delta(await f.counts(), beforeNew), { messages: 1, conversations: 1, bindings: 1, receipts: 1, events: 2, search: 1 }, 'a task without a thread gets its first one');
  for (const [task, sequence] of [[a, 2], [b, 2], [c, 1]] as const) {
    const read = await f.discussion(f.reader, task.id);
    const message = read.messages.at(-1)!;
    assert.deepEqual([message.sequence, message.body, message.contribution, message.authorId, message.source],
      [sequence, line, { kind: 'came_of_it' }, f.writer.id, null], task.title);
    assert.equal(message.conversationId, read.conversationId);
    assert.equal((await f.current(task.id)).cameOfIt, line);
  }
  assert.equal((await f.discussion(f.reader, a.id)).rootMessageId, humanRoot.id);
  assert.equal((await f.discussion(f.reader, b.id)).rootMessageId, agentRoot.id, 'an existing agent root stays the root');
  assert.equal((await f.discussion(f.reader, b.id)).root?.author?.id, agent.id);
  assert.equal((await f.discussion(f.reader, unrelated.id)).root, null, 'an unfinished task gets no thread');
  const stored = (await pool.query("SELECT contribution_kind,author_id,client_message_id FROM project_messages WHERE contribution_kind='came_of_it' AND project_id=$1", [f.place.id])).rows;
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map((row) => row.client_message_id)).size, 3, 'each task has its own deterministic message identity');

  // Exact stable retry: the same outcome, no second message, event or receipt.
  const afterFinish = await f.counts();
  assert.deepEqual(expectStatus(await f.finish(f.writer, c.id, line, c.version, commandIds[2]), 200), fresh);
  assert.deepEqual(await f.counts(), afterFinish);
  const conflict = await f.finish(f.writer, c.id, 'A different line', c.version, commandIds[2]);
  assert.deepEqual([conflict.status, code(conflict)], [409, 'IDEMPOTENCY_CONFLICT']);
  assert.deepEqual(await f.counts(), afterFinish);
  assert.ok(done.every((item) => item.status === 'done'));
  // A replay needs current authorization.
  await removeFromSpace(f.owner, f.place.id, f.writer);
  const afterRevocation = await f.counts();
  assert.equal((await f.finish(f.writer, c.id, line, c.version, commandIds[2])).status, 404);
  assert.deepEqual(await f.counts(), afterRevocation);
});

test('finishing without a line, or with an empty one, creates no task thread; an outsider cannot finish a task', async () => {
  const f = await scene();
  const [plain, empty, guarded] = [await f.task('Finished plain'), await f.task('Finished empty'), await f.task('Not finished')];
  const base = await f.counts();
  expectStatus(await f.patch(f.writer, plain.id, { status: 'done', clientCommandId: randomUUID() }, plain.version), 200);
  expectStatus(await f.finish(f.writer, empty.id, '   ', empty.version), 200);
  assert.deepEqual(delta(await f.counts(), base), { messages: 0, conversations: 0, bindings: 0, receipts: 2, events: 2, search: 0 });
  assert.equal((await f.current(empty.id)).cameOfIt ?? null, null);
  const before = await f.counts();
  assert.equal((await f.finish(f.outsider, guarded.id, 'Outsider line', guarded.version)).status, 404);
  assert.deepEqual(await f.counts(), before);
});

test('a genuine agent finishing a task with a line or saving a blocker through the native session keeps its tagged author', async () => {
  const f = await scene();
  const { principal, agent } = await agentIn(f);
  const t = await f.task('Agent task');
  const second = await f.task('Second agent task');
  const stored = await db.transaction(async (tx) => {
    const session = nativeWorkInTransaction(tx);
    const blocked = await session.updateWork(principal, t.id, { status: 'blocked', blocker: 'Needs a calibration run', clientCommandId: randomUUID() }, t.version);
    const finished = await session.updateWork(principal, second.id, { status: 'done', cameOfIt: 'Agent measured it', clientCommandId: randomUUID() }, second.version);
    assert.deepEqual(session.eventIntents.map((intent) => intent.kind).sort(),
      ['project.conversation_created.v1', 'project.conversation_created.v1', 'project.work_updated.v1', 'project.work_updated.v1']);
    await session.flushEvents();
    return { blocked, finished };
  });
  assert.equal(stored.blocked.blocker, 'Needs a calibration run');
  assert.equal(stored.finished.cameOfIt, 'Agent measured it');
  for (const task of [t, second]) {
    const read = await f.discussion(f.reader, task.id);
    assert.ok(read.messages.every((row) => row.authorId === null && row.author?.id === agent.id && row.author.kind === 'agent'), 'never a person');
  }
  assert.deepEqual((await f.discussion(f.reader, t.id)).root?.contribution, { kind: 'blocker' });
  assert.deepEqual((await f.discussion(f.reader, second.id)).root?.contribution, { kind: 'came_of_it' });
});

test('an explicit public handoff is a contribution through the same primitive; ACK-like or invalid kinds are not accepted', async () => {
  const f = await scene();
  const t = await f.task('Handoff task');
  const path = `/api/v1/work/${t.id}/discussion`;
  const command = { body: 'Take over the bench test: the rig is calibrated.', clientMessageId: randomUUID(), kind: 'handoff' };
  const base = await f.counts();
  const sent = expectStatus(await f.writer.browser.request('POST', path, { body: command }), 201) as ConversationMessage;
  assert.deepEqual([sent.contribution, sent.authorId, sent.sequence], [{ kind: 'handoff' }, f.writer.id, 1]);
  assert.equal((await f.discussion(f.reader, t.id)).rootMessageId, sent.id);
  assert.deepEqual(delta(await f.counts(), base), { messages: 1, conversations: 1, bindings: 1, receipts: 0, events: 1, search: 1 });
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', path, { body: command }), 201), sent, 'exact retry');
  const reused = await f.writer.browser.request('POST', path, { body: { ...command, kind: 'text' } });
  assert.deepEqual([reused.status, code(reused)], [409, 'IDEMPOTENCY_CONFLICT'], 'the kind is part of the intent');
  for (const kind of ['blocker', 'came_of_it', 'ack']) {
    assert.equal((await f.writer.browser.request('POST', path, { body: { body: 'Not a direct kind', clientMessageId: randomUUID(), kind } })).status, 400, kind);
  }
  assert.equal((await f.counts()).messages, base.messages + 1);
  // The generic conversation entry point has no handoff kind.
  assert.equal((await f.writer.browser.request('POST', `/api/v1/conversations/${sent.conversationId}/messages`, {
    body: { body: 'x', clientMessageId: randomUUID(), kind: 'handoff' } })).status, 400);
  // A genuine agent handoff keeps the tagged variant.
  const { principal, agent } = await agentIn(f);
  const other = await f.task('Agent handoff');
  const agentSent = await taskDiscussionUseCases(db).contribute(principal, other.id, { body: 'Over to the reviewer.', clientMessageId: randomUUID(), kind: 'handoff' });
  assert.deepEqual([agentSent.authorId, agentSent.author?.id, agentSent.contribution], [null, agent.id, { kind: 'handoff' }]);
});

/** Real unit of work whose ports fail after the named write (or around the final event flush). */
function failingAt(point: string) {
  return createWorkUseCases({ run: (action) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const thrower = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      const value = await fn(...args);
      if (name === point) throw new Error(`injected failure after ${name}`);
      return value;
    };
    const base = taskDiscussionPorts(tx, session);
    const discussion = { ...base.discussion, createConversation: thrower('createConversation', base.discussion.createConversation),
      append: thrower('append', base.discussion.append), bind: thrower('bind', base.discussion.bind) };
    const work = workRepository(tx);
    const ports: WorkPorts = { access: policyWorkAccess(tx),
      work: { ...work, updateWork: thrower('updateWork', work.updateWork),
        insertLinks: thrower('insertLinks', work.insertLinks), recordNativeCommand: thrower('recordNativeCommand', work.recordNativeCommand) },
      events: { record: thrower('record', async (...args: Parameters<typeof session.record>) => session.record(...args)) } as WorkPorts['events'],
      contributions: createWorkContributions({ ...base, discussion }) };
    const result = await session.run(() => action(ports));
    if (point === 'beforeFlush') throw new Error('injected failure before the final flush');
    await session.flushEvents();
    if (point === 'afterFlush') throw new Error('injected failure after the final flush');
    return result;
  }) });
}

test('every associated write of a blocker save or a finish with a line rolls the whole unit back; the same command then succeeds exactly once', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Rollback task'), await f.task('Second rollback task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const before = await f.counts();
  const snapshot = async () => ({ counts: await f.counts(), work: (await pool.query('SELECT id,status,blocker,version FROM project_work_items WHERE project_id=$1 ORDER BY id', [f.place.id])).rows });
  const initial = await snapshot();
  const actor = human(f.writer);
  const saveId = randomUUID();
  const save = { blocker: 'Rollback blocker', clientCommandId: saveId };
  for (const point of ['updateWork', 'createConversation', 'append', 'bind', 'record', 'recordNativeCommand', 'beforeFlush', 'afterFlush']) {
    await assert.rejects(failingAt(point).updateWork(actor, t.id, save, blocked.version), /injected failure/, point);
    assert.deepEqual(await snapshot(), initial, `blocker save rolled back completely after ${point}`);
  }
  const finish = { status: 'done' as const, cameOfIt: 'Rollback line', clientCommandId: randomUUID() };
  for (const point of ['updateWork', 'createConversation', 'append', 'bind', 'record', 'recordNativeCommand', 'beforeFlush', 'afterFlush']) {
    await assert.rejects(failingAt(point).updateWork(actor, u.id, finish, u.version), /injected failure/, point);
    assert.deepEqual(await snapshot(), initial, `the finish rolled back completely after ${point}`);
  }
  const saved = expectStatus(await f.patch(f.writer, t.id, save, blocked.version), 200) as WorkItem;
  const finished = expectStatus(await f.patch(f.writer, u.id, finish, u.version), 200) as WorkItem;
  const final = await f.counts();
  assert.deepEqual(delta(final, before), { messages: 2, conversations: 2, bindings: 2, receipts: 2, events: 4, search: 2 });
  // A replay returns the current presentation of the original outcome.
  const replayed = expectStatus(await f.patch(f.writer, t.id, save, blocked.version), 200) as WorkItem;
  assert.deepEqual([replayed.version, replayed.blocker], [saved.version, saved.blocker]);
  const { creationUndo, ...currentFields } = await f.current(t.id);
  // The creator's own task (#763 B1) is no longer undoable once it was changed and used.
  assert.equal(creationUndo?.eligible, false, 'current GET rechecks eligibility of the genuine human creation');
  assert.ok(['task_used', 'creation_changed'].includes(creationUndo!.reason), creationUndo!.reason);
  assert.equal(replayed.creationUndo, undefined, 'PATCH replay retains its original domain projection');
  assert.deepEqual(replayed, currentFields);
  assert.deepEqual(expectStatus(await f.patch(f.writer, u.id, finish, u.version), 200), finished);
  assert.deepEqual(await f.counts(), final, 'the stable retries after the recovered failures add nothing');
});

test('failure in a caller-owned native transaction before or after the final flush leaves no blocker, line, message, event or receipt', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Caller task'), await f.task('Second caller task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const before = await f.counts();
  for (const phase of ['before', 'after']) {
    await assert.rejects(db.transaction(async (tx) => {
      const session = nativeWorkInTransaction(tx);
      await session.updateWork(human(f.writer), t.id, { blocker: 'Atomic blocker', clientCommandId: randomUUID() }, blocked.version);
      await session.updateWork(human(f.writer), u.id, { status: 'done', cameOfIt: 'Atomic line', clientCommandId: randomUUID() }, u.version);
      assert.equal(session.eventIntents.length, 4);
      if (phase === 'after') await session.flushEvents();
      throw new Error(`outer failure ${phase} the final flush`);
    }), /outer failure/);
    assert.deepEqual(await f.counts(), before);
    assert.equal((await f.discussion(f.reader, t.id)).root, null);
    assert.equal((await f.current(t.id)).version, blocked.version);
    assert.equal((await f.current(u.id)).status, 'open');
  }
});

test('simultaneous first contributions, finishes with a line, blocker saves and generic replies keep one root and one gapless sequence without deadlock', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const [a, b, c] = [await f.task('Race A'), await f.task('Race B'), await f.task('Race C')];
  const blockedA = expectStatus(await f.patch(f.owner, a.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const use = taskDiscussionUseCases(db);
  const settledAll = await Promise.all([
    f.patch(f.writer, a.id, { blocker: 'Race blocker', clientCommandId: randomUUID() }, blockedA.version),
    f.finish(f.owner, b.id, 'Race line 1', b.version),
    f.finish(f.writer, c.id, 'Race line 2', c.version),
    f.owner.browser.request('POST', `/api/v1/work/${a.id}/discussion`, { body: { body: 'Race text', clientMessageId: randomUUID() } }),
    use.contribute(principal, a.id, { body: 'Race handoff', clientMessageId: randomUUID(), kind: 'handoff' }).then((message) => ({ status: 201, json: message })),
  ]);
  for (const response of settledAll) assert.ok([200, 201].includes(response.status), `${response.status}: ${JSON.stringify(response.json)}`);
  for (const task of [a, b, c]) {
    const read = await f.discussion(f.reader, task.id, '?limit=100');
    const sequences = read.messages.map((row) => row.sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1), `${task.title}: gapless sequence`);
    assert.equal(read.root?.sequence, 1);
    assert.equal(read.rootMessageId, read.messages[0]!.id);
  }
  const bindings = (await pool.query('SELECT count(*)::int AS n FROM project_task_discussions WHERE project_id=$1', [f.place.id])).rows[0].n;
  const conversations = (await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE project_id=$1', [f.place.id])).rows[0].n;
  assert.deepEqual([bindings, conversations], [3, 3]);
  const read = await f.discussion(f.reader, a.id, '?limit=100');
  assert.equal(read.messages.length, 3, 'blocker, text and handoff all landed once in the first task');
  // Generic replies to a bound conversation interleave with native effects (explicit handoffs) through the same task order.
  const generic = await Promise.all(Array.from({ length: 4 }, (_, index) => index % 2
    ? f.writer.browser.request('POST', `/api/v1/conversations/${read.conversationId}/messages`, { body: { body: `Generic ${index}`, clientMessageId: randomUUID() } })
    : f.owner.browser.request('POST', `/api/v1/work/${a.id}/discussion`, { body: { body: `Interleaved ${index}`, clientMessageId: randomUUID(), kind: 'handoff' } })));
  for (const response of generic) assert.ok([200, 201].includes(response.status), JSON.stringify(response.json));
  const after = (await f.discussion(f.reader, a.id, '?limit=100')).messages.map((row) => row.sequence);
  assert.deepEqual(after, after.map((_, index) => index + 1));
  assert.equal(after.length, 3 + 4);
});

test('a generic reply to a task-bound conversation takes the task row before the conversation sequence', async () => {
  const f = await scene();
  const t = await f.task('Bound conversation');
  const root = expectStatus(await f.writer.browser.request('POST', `/api/v1/work/${t.id}/discussion`, {
    body: { body: 'The root of the task thread.', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  let reply!: ReturnType<Person['browser']['request']>;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${t.id} FOR UPDATE`);
    const holder = await backendPid(tx);
    reply = f.owner.browser.request('POST', `/api/v1/conversations/${root.conversationId}/messages`, {
      body: { body: 'A generic reply that waits for the task.', clientMessageId: randomUUID() } });
    const done = settled(reply);
    await waitUntilBlockedBy(pool, holder);
    assert.equal(done(), false);
    // The waiting reply has NOT locked the conversation: it joined the task order, it did not take the conversation first.
    const probe = await pool.query('SELECT id FROM project_conversations WHERE id=$1 FOR UPDATE NOWAIT', [root.conversationId]);
    assert.equal(probe.rows.length, 1);
  });
  const sent = expectStatus(await reply, 201) as ConversationMessage;
  assert.equal(sent.sequence, 2);
  // A conversation that is not bound to any task is unaffected.
  const free = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, {
    body: { body: 'An ordinary conversation.', clientMessageId: randomUUID() } }), 201) as Conversation;
  expectStatus(await f.owner.browser.request('POST', `/api/v1/conversations/${free.id}/messages`, { body: { body: 'Plain reply', clientMessageId: randomUUID() } }), 201);
});

// ---- the shared #152 connection-command ledger composes with the native effects in one transaction ----

async function agentFixture() {
  const f = await scene();
  const agent = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, { body: { name: 'Ledger agent', owner: 'self' } }), 201) as { id: string };
  const connection = await createConnection(pool, f.owner.browser, { agentId: agent.id }) as AgentConnection;
  const clientId = `contribution-fixture-${randomUUID()}`; const bindingId = randomUUID();
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)', [randomUUID(), clientId, 'Contribution ledger fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)', [bindingId, f.owner.id, connection.id, clientId]);
  const claims = { ownerUserId: f.owner.id, connectionId: connection.id, clientId, grantReferenceId: `flux-grant:${bindingId}` };
  const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
  const principal = { kind: 'agent' as const, id: agent.id };
  let effects = 0;
  /** Authority and the ONE ledger first, then the native effect, then one final event batch: the production composition. */
  async function run(command: AgentExecutionCommand, effect: (native: ReturnType<typeof nativeWorkInTransaction>) => Promise<{ value: AgentJsonValue; postconditions: AgentPostcondition[] }>, failAfter = false) {
    return db.transaction(async (tx) => {
      const native = nativeWorkInTransaction(tx);
      const value = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims)).run(command, async (scope) => {
        if (scope.replay) return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        effects++;
        return effect(native);
      });
      if (failAfter) throw new Error('injected failure after debit, receipt and effect');
      await native.flushEvents();
      return value;
    });
  }
  return { ...f, agent, connection, runtime, principal, run, effects: () => effects };
}

test('an agent saving a blocker or finishing a task with a line composes the native effect with the ONE connection-command ledger atomically', async () => {
  const g = await agentFixture();
  const t = await g.task('Ledger task'); const u = await g.task('Second ledger task');
  const blocked = expectStatus(await g.patch(g.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const update: AgentExecutionCommand = { runtimeSessionId: g.runtime.id, clientCommandId: randomUUID(), projectId: g.place.id,
    operation: 'work.update', peerRequestClass: 'execute', audience: { kind: 'project', projectId: g.place.id }, objectId: t.id, sources: [],
    payload: { blocker: 'Ledger blocker', expectedVersion: blocked.version } };
  const saveBlocker = (native: ReturnType<typeof nativeWorkInTransaction>) => native.updateWork(g.principal, t.id, { blocker: 'Ledger blocker', clientCommandId: update.clientCommandId }, blocked.version)
    .then((view) => ({ value: { workId: view.id, version: view.version } as AgentJsonValue, postconditions: [{ kind: 'work' as const, id: view.id, version: view.version }] }));
  const base = await g.counts();
  const ledger = async () => ({
    receipts: (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [g.connection.id])).rows[0].n as number });
  // Failure after the debit, receipt and effect rolls back ALL of them, including the contribution and its native receipt.
  await assert.rejects(g.run(update, saveBlocker, true), /injected failure after debit/);
  assert.deepEqual([await g.counts(), await ledger()], [base, { receipts: 0 }]);
  const first = await g.run(update, saveBlocker);
  assert.deepEqual(await ledger(), { receipts: 1 });
  const read = await g.discussion(g.reader, t.id);
  assert.deepEqual([read.root?.body, read.root?.contribution, read.root?.authorId, read.root?.author?.id, read.root?.author?.kind],
    ['Ledger blocker', { kind: 'blocker' }, null, g.agent.id, 'agent']);
  assert.deepEqual(delta(await g.counts(), base), { messages: 1, conversations: 1, bindings: 1, receipts: 1, events: 2, search: 1 });
  // A matching retry replays the ledger value: no effect, no second message, no second debit, no second event.
  const afterFirst = await g.counts();
  assert.deepEqual(await g.run(update, saveBlocker), first);
  assert.deepEqual([await g.counts(), await ledger(), g.effects()], [afterFirst, { receipts: 1 }, 2]);
  // Changed produced state stays stale, never a second contribution.
  expectStatus(await g.patch(g.owner, t.id, { title: 'Someone moved the task' }, (first as { version: number }).version), 200);
  await assert.rejects(g.run(update, saveBlocker), (error: unknown) => error instanceof DomainError && error.code === 'COMMAND_POSTSTATE_STALE');
  assert.equal((await g.discussion(g.reader, t.id)).messages.length, 1);

  const finish: AgentExecutionCommand = { runtimeSessionId: g.runtime.id, clientCommandId: randomUUID(), projectId: g.place.id,
    operation: 'work.update', peerRequestClass: 'execute', audience: { kind: 'project', projectId: g.place.id }, objectId: u.id, sources: [],
    payload: { status: 'done', cameOfIt: 'Ledger line', expectedVersion: u.version } };
  const finishing = (native: ReturnType<typeof nativeWorkInTransaction>) => native.updateWork(g.principal, u.id,
    { status: 'done', cameOfIt: 'Ledger line', clientCommandId: finish.clientCommandId }, u.version)
    .then((view) => ({ value: { workId: view.id, version: view.version } as AgentJsonValue, postconditions: [{ kind: 'work' as const, id: view.id, version: view.version }] }));
  const beforeFinish = await g.counts();
  const finished = await g.run(finish, finishing) as { workId: string; version: number };
  assert.deepEqual(delta(await g.counts(), beforeFinish), { messages: 1, conversations: 1, bindings: 1, receipts: 1, events: 2, search: 1 });
  const message = (await g.discussion(g.reader, u.id)).messages.at(-1)!;
  assert.deepEqual([message.contribution, message.authorId, message.author?.id], [{ kind: 'came_of_it' }, null, g.agent.id]);
  const afterFinish = await g.counts();
  assert.deepEqual(await g.run(finish, finishing), finished);
  assert.deepEqual(await g.counts(), afterFinish);
  assert.equal(g.effects(), 3, 'no replay executed an effect');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM native_command_receipts WHERE actor_kind=$1 AND actor_id=$2', ['agent', g.agent.id])).rows[0].n, 2);
});

test('the receipt and message constraints refuse an unknown contribution kind and a receipt without its produced task', async () => {
  const f = await scene();
  const t = await f.task('Constraint task');
  expectStatus(await f.finish(f.owner, t.id, 'Real line', t.version), 200);
  const read = await f.discussion(f.owner, t.id);
  const message = read.root!;
  const row = (await pool.query('SELECT * FROM project_messages WHERE id=$1', [message.id])).rows[0];
  const insert = (kind: string) => pool.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,
    request_fingerprint,sequence,body,contribution_kind) VALUES($1,$2,$3,$4,$5,$6,'x',99,'x',$7)`,
  [randomUUID(), f.ws.id, f.place.id, message.conversationId, f.owner.id, randomUUID(), kind]);
  await assert.rejects(insert('result'), /project_message_contribution_kind/);
  await assert.rejects(insert('ack'), /project_message_contribution_kind/);
  await assert.rejects(pool.query(`UPDATE project_messages SET contribution_kind='result' WHERE id=$1`, [message.id]), /project_message_contribution_kind/);
  assert.equal(row.contribution_kind, 'came_of_it');
  assert.equal('result_id' in row, false, 'a message names no result');
  const receipt = (operation: string, workId: string | null, version: number | null) => pool.query(`INSERT INTO native_command_receipts(workspace_id,project_id,
    actor_kind,actor_id,operation,client_command_id,request_fingerprint,work_id,work_version) VALUES($1,$2,'human',$3,$4,$5,'x',$6,$7)`,
  [f.ws.id, f.place.id, f.owner.id, operation, randomUUID(), workId, version]);
  await assert.rejects(receipt('work.update', null, null), /not-null|null value/);
  await assert.rejects(receipt('work.update', t.id, null), /not-null|null value/);
  await assert.rejects(receipt('result.create', t.id, 1), /violates check constraint/);
  await assert.rejects(receipt('result.refund', t.id, 1), /violates check constraint/);
  await receipt('work.update', t.id, 1);
  assert.ok((await db.select().from(schema.nativeCommandReceipts).where(eq(schema.nativeCommandReceipts.workId, t.id))).length >= 1);
});

test('blocker and finish-line contributions finish every domain, receipt and response write before one final event batch', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Final batch task'), await f.task('Second final batch task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const events = await db.transaction(async (tx) => {
    const guarded = guardFinalEventPhase(tx);
    const session = nativeWorkInTransaction(guarded.tx);
    await session.updateWork(human(f.writer), t.id, { blocker: 'Batch blocker', clientCommandId: randomUUID() }, blocked.version);
    await session.updateWork(human(f.writer), u.id, { status: 'done', cameOfIt: 'Batch line', clientCommandId: randomUUID() }, u.version);
    assert.equal(guarded.started, false, 'no event was inserted while the work, appends and receipts were prepared');
    assert.equal(session.eventIntents.length, 4);
    const staged = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND classid=((hashtext('flux.events.seq')::bigint >> 32) & 4294967295)::oid
      AND objid=(hashtext('flux.events.seq')::bigint & 4294967295)::oid AND objsubid=1) AS stream_lock`);
    assert.equal(staged.rows[0]!.stream_lock, false, 'the stream lock is taken only by the final flush');
    const flushed = await session.flushEvents();
    assert.equal(guarded.started, true);
    return flushed;
  });
  assert.equal(events.length, 4);
  const audience = (await pool.query('SELECT DISTINCT recipient FROM event_audience WHERE event_id=ANY($1::uuid[])', [events])).rows.map((row) => row.recipient);
  assert.ok(audience.includes(`human:${f.reader.id}`) && audience.includes(`human:${f.owner.id}`), 'every current reader is in the one final audience');
  assert.equal(audience.includes(`human:${f.outsider.id}`), false);
});

test('reads of the effects create nothing, and the transport Idempotency-Key cache composes with the native receipt', async () => {
  const f = await scene();
  const t = await f.task('Transport task');
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const command = { blocker: 'Transport blocker', clientCommandId: randomUUID() };
  const send = (key?: string) => f.writer.browser.request('PATCH', `/api/v1/work/${t.id}`, {
    body: command, headers: { 'if-match': `"${blocked.version}"`, ...(key ? { 'idempotency-key': key } : {}) } });
  const key = `fx-${randomUUID()}`;
  const first = expectStatus(await send(key), 200) as WorkItem;
  const afterFirst = await f.counts();
  const cached = await send(key);
  assert.equal(cached.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(cached.json, first);
  // After the cache would have expired (no key), the durable native receipt still returns the original outcome.
  const durable = await send();
  assert.equal(durable.headers.get('idempotent-replayed'), null);
  assert.deepEqual(durable.json, first);
  assert.deepEqual(await f.counts(), afterFirst);
  for (let i = 0; i < 3; i++) {
    for (const path of [`/api/v1/work/${t.id}/discussion`, `/api/v1/work/${t.id}`, `/api/v1/projects/${f.place.id}/work`]) {
      expectStatus(await f.reader.browser.request('GET', path), 200);
    }
    const read = await f.discussion(f.reader, t.id);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${read.conversationId}`), 200);
  }
  assert.deepEqual(await f.counts(), afterFirst, 'readers write nothing');
});

test('creating a task with a blocker keeps only its creation notice; creation fields are not a saved blocker contribution', async () => {
  const f = await scene();
  const before = await f.counts();
  const created = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, {
    body: { title: 'Born blocked', status: 'blocked', blocker: 'Waiting for the supplier', clientCommandId: randomUUID() } }), 201) as WorkItem;
  assert.equal(created.blocker, 'Waiting for the supplier');
  assert.deepEqual(delta(await f.counts(), before), { messages: 0, conversations: 0, bindings: 0, receipts: 0, events: 1, search: 0 });
  const notices = expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/task-notices`), 200) as { items: Array<{ workId: string; kind: string }> };
  assert.deepEqual(notices.items.filter((item) => item.workId === created.id).map((item) => item.kind), ['task.created']);
  assert.equal((await f.discussion(f.reader, created.id)).root, null);
  // Saving that same blocker explicitly later IS a contribution.
  expectStatus(await f.patch(f.writer, created.id, { blocker: 'Waiting for the supplier', clientCommandId: randomUUID() }, created.version), 200);
  assert.equal((await f.discussion(f.reader, created.id)).root?.body, 'Waiting for the supplier');
});

test('concurrent exact duplicates of a keyed save or a keyed finish share one contribution and one outcome', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Duplicate task'), await f.task('Second duplicate task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const base = await f.counts();
  const save = { blocker: 'Duplicate blocker', clientCommandId: randomUUID() };
  const saves = await Promise.all(Array.from({ length: 4 }, () => f.patch(f.writer, t.id, save, blocked.version)));
  const bodies = saves.map((response) => expectStatus(response, 200) as WorkItem);
  assert.equal(new Set(bodies.map((item) => item.version)).size, 1);
  const finish = { status: 'done', cameOfIt: 'Duplicate line', clientCommandId: randomUUID() };
  const finishes = (await Promise.all(Array.from({ length: 4 }, () => f.patch(f.writer, u.id, finish, u.version)))).map((response) => expectStatus(response, 200) as WorkItem);
  assert.equal(new Set(finishes.map((item) => item.version)).size, 1);
  assert.deepEqual(delta(await f.counts(), base), { messages: 2, conversations: 2, bindings: 2, receipts: 2, events: 4, search: 2 });
});

// ---- the effects coexist with the native task graph (#152 plan, migration 0039) ----

test('finishing with a line and a start honor prerequisites: unmet ones write nothing, met ones finish and contribute', async () => {
  const f = await scene();
  const [pre, dependent] = [await f.task('Prerequisite'), await f.task('Dependent')];
  const linked = expectStatus(await f.patch(f.owner, dependent.id, { dependencyIds: [pre.id] }, dependent.version), 200) as WorkItem;
  assert.deepEqual(linked.dependencyIds, [pre.id]);
  const base = await f.counts();
  const early = await f.finish(f.writer, dependent.id, 'Too early', linked.version);
  assert.deepEqual([early.status, code(early)], [409, 'TASK_PREREQUISITES_UNMET']);
  const start = await f.patch(f.writer, dependent.id, { status: 'in_progress', blocker: null, clientCommandId: randomUUID() }, linked.version);
  assert.deepEqual([start.status, code(start)], [409, 'TASK_PREREQUISITES_UNMET']);
  assert.deepEqual(await f.counts(), base, 'a refused finish or start leaves no message, thread, receipt or event');
  // A blocker save does not start the task, so it is not a graph transition and contributes normally.
  const blocked = expectStatus(await f.patch(f.writer, dependent.id, { status: 'blocked', blocker: 'Waiting for the prerequisite', clientCommandId: randomUUID() }, linked.version), 200) as WorkItem;
  assert.equal((await f.discussion(f.reader, dependent.id)).root?.contribution?.kind, 'blocker');
  expectStatus(await f.patch(f.owner, pre.id, { status: 'done' }, pre.version), 200);
  expectStatus(await f.finish(f.writer, dependent.id, 'Done after its prerequisite', blocked.version), 200);
  assert.equal((await f.current(dependent.id)).status, 'done');
  const thread = await f.discussion(f.reader, dependent.id);
  assert.deepEqual(thread.messages.map((row) => [row.sequence, row.contribution]), [[1, { kind: 'blocker' }], [2, { kind: 'came_of_it' }]]);
});

test('finishing a task with a line locks the task and its prerequisites in ONE ascending pass', async () => {
  const f = await scene();
  const made = [await f.task('Order A'), await f.task('Order B'), await f.task('Order C')].sort((x, y) => (x.id < y.id ? -1 : 1)) as [WorkItem, WorkItem, WorkItem];
  const [a, b, c] = made;
  expectStatus(await f.patch(f.owner, c.id, { status: 'done' }, c.version), 200);
  const dependent = expectStatus(await f.patch(f.owner, b.id, { dependencyIds: [c.id] }, b.version), 200) as WorkItem;
  let pending!: ReturnType<typeof f.finish>;
  await db.transaction(async (tx) => {
    // Hold the HIGHEST task, a prerequisite of the finishing task b. The finish must already hold b before it waits for c:
    // a separate prerequisite pass would take the prerequisite first and leave b free.
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${c.id} FOR UPDATE`);
    const holder = await backendPid(tx);
    pending = f.finish(f.writer, b.id, 'One ascending pass', dependent.version);
    await waitUntilBlockedBy(pool, holder);
    await assert.rejects(pool.query('SELECT 1 FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [b.id]), /could not obtain lock/, 'held before the wait');
    await pool.query('SELECT 1 FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [a.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 0);
  });
  expectStatus(await pending, 200);
  assert.equal((await f.current(b.id)).status, 'done');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 1);
});

test('finishing a task takes the graph lock before the task row', async () => {
  const f = await scene();
  const graphLock = sql`SELECT pg_advisory_xact_lock(hashtextextended(${TASK_GRAPH_LOCK_NAMESPACE + f.place.id}, 0))`;
  // A graph writer holds the graph lock and then takes the task row; the waiting finish must not already hold the row.
  const t = await f.task('Finished task');
  let pending!: ReturnType<typeof f.finish>;
  await db.transaction(async (tx) => {
    await tx.execute(graphLock);
    const holder = await backendPid(tx);
    pending = f.finish(f.owner, t.id, 'The line waits for the graph', t.version);
    await waitUntilBlockedBy(pool, holder);
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${t.id} FOR UPDATE NOWAIT`);
  });
  expectStatus(await pending, 200);
  assert.equal((await f.current(t.id)).status, 'done');
  assert.deepEqual((await f.discussion(f.reader, t.id)).root?.contribution, { kind: 'came_of_it' });
});

test('replacing prerequisites and saving a blocker in one keyed command is one outcome: exact replay, set semantics, changed intent conflicts', async () => {
  const f = await scene();
  const [t, first, second] = [await f.task('Planned'), await f.task('First prerequisite'), await f.task('Second prerequisite')];
  const command = { status: 'blocked', blocker: 'Waiting for both prerequisites', dependencyIds: [first.id, second.id], clientCommandId: randomUUID() };
  const base = await f.counts();
  const saved = expectStatus(await f.patch(f.writer, t.id, command, t.version), 200) as WorkItem;
  assert.deepEqual(saved.dependencyIds, [first.id, second.id].sort());
  assert.deepEqual(delta(await f.counts(), base), { messages: 1, conversations: 1, bindings: 1, receipts: 1, events: 2, search: 1 });
  const afterSave = await f.counts();
  const swapped = await f.patch(f.writer, t.id, { ...command, dependencyIds: [second.id, first.id] }, t.version);
  assert.deepEqual([swapped.status, (swapped.json as WorkItem).dependencyIds], [200, saved.dependencyIds], 'the order of prerequisites is not part of the intent');
  assert.deepEqual(await f.counts(), afterSave);
  const changed = await f.patch(f.writer, t.id, { ...command, dependencyIds: [first.id] }, t.version);
  assert.deepEqual([changed.status, code(changed)], [409, 'IDEMPOTENCY_CONFLICT']);
  const cycle = await f.patch(f.writer, first.id, { dependencyIds: [t.id], clientCommandId: randomUUID() }, first.version);
  assert.deepEqual([cycle.status, code(cycle)], [409, 'TASK_DEPENDENCY_CYCLE']);
  assert.equal((await f.counts()).messages, afterSave.messages, 'a refused graph change contributes nothing');
});
