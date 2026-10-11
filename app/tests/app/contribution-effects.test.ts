import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { schema, TASK_GRAPH_LOCK_NAMESPACE } from '@flux/db';
import { agentExecutionUseCases, createAssistantProposalUseCases, createWorkContributions, createWorkUseCases, DomainError, type Principal, type ProposalRecord,
  type WorkPorts } from '@flux/core';
import type { AgentConnection, AgentExecutionCommand, AgentJsonValue, AgentPostcondition, AgentStandingGrant, AssistantProposal, Conversation, ConversationMessage,
  Decision, TaskDiscussion, WorkItem, WorkResult } from '@flux/contracts';
import { nativeWorkInTransaction, policyWorkAccess, workRepository } from '../../apps/server/src/work/adapters.js';
import { proposalUnitOfWork } from '../../apps/server/src/personal-runs/adapters.js';
import { FakeQueue } from './support/personal-runs.js';
import { taskDiscussionPorts, taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { transactionEventSession } from '../../apps/server/src/work/transaction-events.js';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { agentExecutionInTransaction } from '../../apps/server/src/agent-connection/execution.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, settled, waitUntilBlockedBy } from './support/locks.js';
import { guardFinalEventPhase } from './support/final-events.js';
import { db, pool } from './support/db.js';

// Explicit native contribution effects on the canonical task thread (#154): a saved blocker, a published result
// and an explicit public handoff, each through the one canonical append, over real PostgreSQL and HTTP.

async function scene() {
  const [owner, writer, reader, outsider] = await Promise.all(['fx-owner', 'fx-writer', 'fx-reader', 'fx-outsider'].map(person));
  const ws = await workspace(owner, 'Contribution effects');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Effects trial', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
  const task = async (title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title, clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_messages WHERE project_id=$1) AS messages,
    (SELECT count(*)::int FROM project_conversations WHERE project_id=$1) AS conversations,
    (SELECT count(*)::int FROM project_task_discussions WHERE project_id=$1) AS bindings,
    (SELECT count(*)::int FROM project_results WHERE project_id=$1) AS results,
    (SELECT count(*)::int FROM native_command_receipts WHERE project_id=$1) AS receipts,
    (SELECT count(*)::int FROM events WHERE object_id=$1) AS events,
    (SELECT count(*)::int FROM search_documents WHERE project_id=$1 AND kind='message') AS search,
    (SELECT count(*)::int FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.object_id=$1) AS outbox`, [place.id])).rows[0] as Record<string, number>;
  const discussion = async (who: Person, workId: string, query = '') =>
    expectStatus(await who.browser.request('GET', `/api/v1/work/${workId}/discussion${query}`), 200) as TaskDiscussion;
  const patch = (who: Person, workId: string, body: Record<string, unknown>, version: number) =>
    who.browser.request('PATCH', `/api/v1/work/${workId}`, { body, headers: { 'if-match': `"${version}"` } });
  const result = (who: Person, body: Record<string, unknown>) => who.browser.request('POST', `/api/v1/projects/${place.id}/results`, { body });
  const current = async (workId: string) => expectStatus(await owner.browser.request('GET', `/api/v1/work/${workId}`), 200) as WorkItem;
  return { owner, writer, reader, outsider, ws, place, task, counts, discussion, patch, result, current };
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
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201);
  return { agent, principal: { kind: 'agent' as const, id: agent.id } };
}

test('an explicitly saved nonempty blocker contributes its exact text; clearing and status/owner/title changes contribute nothing', async () => {
  const f = await scene();
  const t = await f.task('Compare current measurements');
  const base = await f.counts();
  let item = expectStatus(await f.patch(f.writer, t.id, { status: 'blocked', clientCommandId: randomUUID() }, 1), 200) as WorkItem;
  item = expectStatus(await f.patch(f.writer, t.id, { owner: { kind: 'human', id: f.writer.id }, clientCommandId: randomUUID() }, item.version), 200) as WorkItem;
  item = expectStatus(await f.patch(f.writer, t.id, { title: 'Compare measurements', clientCommandId: randomUUID() }, item.version), 200) as WorkItem;
  assert.deepEqual(delta(await f.counts(), base), { messages: 0, conversations: 0, bindings: 0, results: 0, receipts: 3, events: 3, search: 0 },
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
  assert.deepEqual(delta(await f.counts(), quiet), { messages: 1, conversations: 1, bindings: 1, results: 0, receipts: 1, events: 2, search: 1 });
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

test('blocker saves obey current access: viewers are forbidden, outsiders see nothing, and nothing is contributed', async () => {
  const f = await scene();
  const t = await f.task('Guarded task');
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const before = await f.counts();
  const viewer = await f.patch(f.reader, t.id, { blocker: 'Not allowed', clientCommandId: randomUUID() }, blocked.version);
  assert.equal(viewer.status, 403);
  assert.equal((await f.patch(f.outsider, t.id, { blocker: 'Hidden', clientCommandId: randomUUID() }, blocked.version)).status, 404);
  assert.equal((await f.patch(f.owner, t.id, { blocker: '   '.repeat(2), clientCommandId: randomUUID() }, blocked.version)).status, 200, 'a whitespace-only blocker is an empty clear');
  assert.equal((await f.counts()).messages, before.messages);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  const denied = await f.patch(f.writer, t.id, { blocker: 'Revoked', clientCommandId: randomUUID() }, blocked.version + 1);
  assert.equal(denied.status, 404);
  assert.equal((await f.counts()).messages, before.messages);
});

test('a published result contributes one canonical result message to every linked task, bound or not, in sorted order', async () => {
  const f = await scene();
  const { principal: genuine, agent } = await agentIn(f);
  const [a, b, c, unrelated] = [await f.task('Task A'), await f.task('Task B'), await f.task('Task C'), await f.task('Unlinked task')];
  const use = taskDiscussionUseCases(db);
  const humanRoot = await use.contribute(human(f.owner), a.id, { body: 'A person opened this task thread.', clientMessageId: randomUUID() });
  const agentRoot = await use.contribute(genuine, b.id, { body: 'An agent opened this one.', clientMessageId: randomUUID() });
  const base = await f.counts();
  const commandId = randomUUID();
  const body = { title: 'The hinge holds at 40 N', finding: 'positive', evidence: 'Bench log 12', work: [c.id, a.id, b.id],
    finishes: { id: c.id, expectedVersion: c.version }, clientCommandId: commandId };
  const made = expectStatus(await f.result(f.writer, body), 201) as WorkResult;
  assert.deepEqual(delta(await f.counts(), base), { messages: 3, conversations: 1, bindings: 1, results: 1, receipts: 1, events: 4,
    search: 3 }, 'one result, one message per task, one new thread, four events');
  for (const [task, sequence] of [[a, 2], [b, 2], [c, 1]] as const) {
    const read = await f.discussion(f.reader, task.id);
    const message = read.messages.at(-1)!;
    assert.deepEqual([message.sequence, message.body, message.contribution, message.authorId, message.source],
      [sequence, 'The hinge holds at 40 N', { kind: 'result', resultId: made.id }, f.writer.id, null], task.title);
    assert.equal(message.conversationId, read.conversationId);
  }
  assert.equal((await f.discussion(f.reader, a.id)).rootMessageId, humanRoot.id);
  assert.equal((await f.discussion(f.reader, b.id)).rootMessageId, agentRoot.id, 'an existing agent root stays the root');
  assert.equal((await f.discussion(f.reader, b.id)).root?.author?.id, agent.id);
  assert.equal((await f.discussion(f.reader, unrelated.id)).root, null, 'an unlinked task gets no thread');
  assert.equal((await f.current(c.id)).status, 'done');
  const canonical = expectStatus(await f.reader.browser.request('GET', `/api/v1/results/${made.id}`), 200) as WorkResult;
  assert.deepEqual([canonical.title, canonical.finding, canonical.evidence, canonical.createdBy.id], ['The hinge holds at 40 N', 'positive', 'Bench log 12', f.writer.id],
    'the typed result reference resolves to the canonical result through its ordinary authorized API');
  const stored = (await pool.query('SELECT contribution_kind,result_id,author_id,client_message_id FROM project_messages WHERE result_id=$1 ORDER BY sequence, created_at', [made.id])).rows;
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map((row) => row.client_message_id)).size, 3, 'each task has its own deterministic message identity');

  // Exact stable retry: the same canonical result, no second result, message, event or receipt.
  const afterPublish = await f.counts();
  assert.deepEqual(expectStatus(await f.result(f.writer, { ...body, work: [a.id, b.id, c.id] }), 201), made);
  assert.deepEqual(await f.counts(), afterPublish);
  const conflict = await f.result(f.writer, { ...body, title: 'A different finding' });
  assert.deepEqual([conflict.status, code(conflict)], [409, 'IDEMPOTENCY_CONFLICT']);
  assert.deepEqual(await f.counts(), afterPublish);
  // A replay needs current authorization.
  await grant(f.owner, f.place.id, f.writer, 'denied');
  const afterRevocation = await f.counts();
  assert.equal((await f.result(f.writer, body)).status, 404);
  assert.deepEqual(await f.counts(), afterRevocation);
});

test('a result with no linked task, or only a decision, creates no task thread; a viewer cannot publish', async () => {
  const f = await scene();
  const decision = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/decisions`, { body: { title: 'Use hinge B' } }), 201) as Decision;
  const base = await f.counts();
  expectStatus(await f.result(f.writer, { title: 'A project-level finding', finding: 'negative', clientCommandId: randomUUID() }), 201);
  expectStatus(await f.result(f.writer, { title: 'About a decision', finding: 'positive', decisions: [decision.id] }), 201);
  assert.deepEqual(delta(await f.counts(), base), { messages: 0, conversations: 0, bindings: 0, results: 2, receipts: 1, events: 2, search: 0 });
  const t = await f.task('Not linked');
  const before = await f.counts();
  assert.equal((await f.result(f.reader, { title: 'Viewer result', finding: 'positive', work: [t.id] })).status, 403);
  assert.equal((await f.result(f.outsider, { title: 'Outsider result', finding: 'positive', work: [t.id] })).status, 404);
  assert.deepEqual(await f.counts(), before);
});

test('a genuine agent publishing a result or saving a blocker through the native session keeps its tagged author', async () => {
  const f = await scene();
  const { principal, agent } = await agentIn(f);
  const t = await f.task('Agent task');
  const second = await f.task('Second agent task');
  const stored = await db.transaction(async (tx) => {
    const session = nativeWorkInTransaction(tx);
    const blocked = await session.updateWork(principal, t.id, { status: 'blocked', blocker: 'Needs a calibration run', clientCommandId: randomUUID() }, t.version);
    const result = await session.createResult(principal, f.place.id, { title: 'Agent measured it', finding: 'positive', work: [second.id, t.id] });
    // Task order after the result is the sorted task id order, so compare the set of kinds.
    assert.deepEqual(session.eventIntents.map((intent) => intent.kind).sort(),
      ['project.conversation_created.v1', 'project.conversation_created.v1', 'project.message_sent.v1', 'project.result_recorded.v1', 'project.work_updated.v1']);
    await session.flushEvents();
    return { blocked, result };
  });
  assert.equal(stored.blocked.blocker, 'Needs a calibration run');
  for (const task of [t, second]) {
    const read = await f.discussion(f.reader, task.id);
    assert.ok(read.messages.every((row) => row.authorId === null && row.author?.id === agent.id && row.author.kind === 'agent'), 'never a person');
    assert.deepEqual(read.messages.at(-1)!.contribution, { kind: 'result', resultId: stored.result.id });
  }
  assert.deepEqual((await f.discussion(f.reader, t.id)).root?.contribution, { kind: 'blocker' });
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
  assert.deepEqual(delta(await f.counts(), base), { messages: 1, conversations: 1, bindings: 1, results: 0, receipts: 0, events: 1, search: 1 });
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', path, { body: command }), 201), sent, 'exact retry');
  const reused = await f.writer.browser.request('POST', path, { body: { ...command, kind: 'text' } });
  assert.deepEqual([reused.status, code(reused)], [409, 'IDEMPOTENCY_CONFLICT'], 'the kind is part of the intent');
  for (const kind of ['blocker', 'result', 'ack']) {
    assert.equal((await f.writer.browser.request('POST', path, { body: { body: 'Not a direct kind', clientMessageId: randomUUID(), kind } })).status, 400, kind);
  }
  assert.equal((await f.reader.browser.request('POST', path, { body: { ...command, clientMessageId: randomUUID() } })).status, 403);
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
      work: { ...work, updateWork: thrower('updateWork', work.updateWork), insertResult: thrower('insertResult', work.insertResult),
        insertLinks: thrower('insertLinks', work.insertLinks), recordNativeCommand: thrower('recordNativeCommand', work.recordNativeCommand) },
      events: { record: thrower('record', async (...args: Parameters<typeof session.record>) => session.record(...args)) } as WorkPorts['events'],
      contributions: createWorkContributions({ ...base, discussion }),
      backgroundComparison: { prepareHumanNegative: async () => {}, taskTargets: async () => [], enqueueHumanNegative: async () => 0 } };
    const result = await session.run(() => action(ports));
    if (point === 'beforeFlush') throw new Error('injected failure before the final flush');
    await session.flushEvents();
    if (point === 'afterFlush') throw new Error('injected failure after the final flush');
    return result;
  }) });
}

test('every associated write of a blocker save or a result rolls the whole unit back; the same command then succeeds exactly once', async () => {
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
  const publishId = randomUUID();
  const publish = { title: 'Rollback result', finding: 'positive' as const, work: [u.id, t.id], finishes: { id: u.id, expectedVersion: u.version }, clientCommandId: publishId };
  for (const point of ['insertResult', 'insertLinks', 'updateWork', 'createConversation', 'append', 'bind', 'record', 'recordNativeCommand', 'beforeFlush', 'afterFlush']) {
    await assert.rejects(failingAt(point).createResult(actor, f.place.id, publish), /injected failure/, point);
    assert.deepEqual(await snapshot(), initial, `result rolled back completely after ${point}`);
  }
  const saved = expectStatus(await f.patch(f.writer, t.id, save, blocked.version), 200) as WorkItem;
  const published = expectStatus(await f.result(f.writer, publish), 201) as WorkResult;
  const final = await f.counts();
  assert.deepEqual(delta(final, before), { messages: 3, conversations: 2, bindings: 2, results: 1, receipts: 2, events: 5, search: 3 });
  // A replay returns the current presentation of the original outcome (the result has since linked the task).
  const replayed = expectStatus(await f.patch(f.writer, t.id, save, blocked.version), 200) as WorkItem;
  assert.deepEqual([replayed.version, replayed.blocker], [saved.version, saved.blocker]);
  const { creationUndo, ...currentFields } = await f.current(t.id);
  assert.deepEqual(creationUndo, { eligible: false, reason: 'not_ai_origin' }, 'current GET rechecks eligibility of the genuine human creation');
  assert.equal(replayed.creationUndo, undefined, 'PATCH replay retains its original domain projection');
  assert.deepEqual(replayed, currentFields);
  assert.deepEqual(expectStatus(await f.result(f.writer, publish), 201), published);
  assert.deepEqual(await f.counts(), final, 'the stable retries after the recovered failures add nothing');
});

test('failure in a caller-owned native transaction before or after the final flush leaves no blocker, result, message, event or receipt', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Caller task'), await f.task('Second caller task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const before = await f.counts();
  for (const phase of ['before', 'after']) {
    await assert.rejects(db.transaction(async (tx) => {
      const session = nativeWorkInTransaction(tx);
      await session.updateWork(human(f.writer), t.id, { blocker: 'Atomic blocker', clientCommandId: randomUUID() }, blocked.version);
      await session.createResult(human(f.writer), f.place.id, { title: 'Atomic result', finding: 'negative', work: [t.id, u.id], clientCommandId: randomUUID() });
      assert.equal(session.eventIntents.length, 5);
      if (phase === 'after') await session.flushEvents();
      throw new Error(`outer failure ${phase} the final flush`);
    }), /outer failure/);
    assert.deepEqual(await f.counts(), before);
    assert.equal((await f.discussion(f.reader, t.id)).root, null);
    assert.equal((await f.current(t.id)).version, blocked.version);
  }
});

test('overlapping results lock the complete sorted task set: a held later task does not stop the earlier from being locked first', async () => {
  const f = await scene();
  const tasks = [await f.task('Lock A'), await f.task('Lock B'), await f.task('Lock C')];
  const [a, b] = tasks.map((task) => task.id).sort() as [string, string, string];
  let pending!: ReturnType<typeof f.result>;
  await db.transaction(async (tx) => {
    // Hold the LATER task; a result listing it first must still take the earlier task before it waits here.
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${b} FOR UPDATE`);
    const holder = await backendPid(tx);
    pending = f.result(f.writer, { title: 'Opposing order', finding: 'positive', work: [b, a], clientCommandId: randomUUID() });
    await waitUntilBlockedBy(pool, holder);
    await assert.rejects(pool.query('SELECT 1 FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [a]), /could not obtain lock/,
      'the waiting result already holds the sorted-first task');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 0, 'nothing is appended before the full set is locked');
  });
  expectStatus(await pending, 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 2);
});

test('simultaneous first contributions, results, blocker saves and generic replies keep one root and one gapless sequence without deadlock', async () => {
  const f = await scene();
  const { principal } = await agentIn(f);
  const [a, b, c] = [await f.task('Race A'), await f.task('Race B'), await f.task('Race C')];
  const blockedA = expectStatus(await f.patch(f.owner, a.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const use = taskDiscussionUseCases(db);
  const settledAll = await Promise.all([
    f.patch(f.writer, a.id, { blocker: 'Race blocker', clientCommandId: randomUUID() }, blockedA.version),
    f.result(f.owner, { title: 'Race result 1', finding: 'positive', work: [a.id, b.id, c.id], clientCommandId: randomUUID() }),
    f.result(f.writer, { title: 'Race result 2', finding: 'negative', work: [c.id, b.id, a.id], clientCommandId: randomUUID() }),
    f.result(f.owner, { title: 'Race result 3', finding: 'positive', work: [b.id, c.id, a.id] }),
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
  assert.equal(read.messages.length, 6, 'blocker, text, handoff and three results all landed once in the first task');
  // Generic replies to a bound conversation interleave with native effects through the same task order.
  const generic = await Promise.all(Array.from({ length: 4 }, (_, index) => index % 2
    ? f.writer.browser.request('POST', `/api/v1/conversations/${read.conversationId}/messages`, { body: { body: `Generic ${index}`, clientMessageId: randomUUID() } })
    : f.result(f.owner, { title: `Interleaved ${index}`, finding: 'positive', work: [c.id, a.id], clientCommandId: randomUUID() })));
  for (const response of generic) assert.ok([200, 201].includes(response.status), JSON.stringify(response.json));
  const after = (await f.discussion(f.reader, a.id, '?limit=100')).messages.map((row) => row.sequence);
  assert.deepEqual(after, after.map((_, index) => index + 1));
  assert.equal(after.length, 6 + 4);
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
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expectStatus(await f.owner.browser.request('POST', '/api/v1/agent-connections', {
    body: { agentId: agent.id, selectedProjectIds: [f.place.id], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201) as AgentConnection;
  const clientId = `contribution-fixture-${randomUUID()}`; const bindingId = randomUUID();
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)', [randomUUID(), clientId, 'Contribution ledger fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)', [bindingId, f.owner.id, connection.id, clientId]);
  const claims = { ownerUserId: f.owner.id, connectionId: connection.id, clientId, grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes };
  const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
  const grantFor = async (operation: 'work.update' | 'result.record') => expectStatus(await f.owner.browser.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: {
    clientCommandId: randomUUID(), projectId: f.place.id, operation, peerRequestClass: 'execute', maximumUses: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
  const updateGrant = await grantFor('work.update'); const resultGrant = await grantFor('result.record');
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
  return { ...f, agent, connection, runtime, updateGrant, resultGrant, principal, run, effects: () => effects };
}

test('an agent saving a blocker or publishing a result composes the native effect with the ONE connection-command ledger atomically', async () => {
  const g = await agentFixture();
  const t = await g.task('Ledger task'); const u = await g.task('Second ledger task');
  const blocked = expectStatus(await g.patch(g.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const update: AgentExecutionCommand = { runtimeSessionId: g.runtime.id, grantId: g.updateGrant.id, clientCommandId: randomUUID(), projectId: g.place.id,
    operation: 'work.update', peerRequestClass: 'execute', audience: { kind: 'project', projectId: g.place.id }, objectId: t.id, sources: [],
    payload: { blocker: 'Ledger blocker', expectedVersion: blocked.version } };
  const saveBlocker = (native: ReturnType<typeof nativeWorkInTransaction>) => native.updateWork(g.principal, t.id, { blocker: 'Ledger blocker', clientCommandId: update.clientCommandId }, blocked.version)
    .then((view) => ({ value: { workId: view.id, version: view.version } as AgentJsonValue, postconditions: [{ kind: 'work' as const, id: view.id, version: view.version }] }));
  const base = await g.counts();
  const ledger = async () => ({
    uses: (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [g.updateGrant.id])).rows[0].used as number,
    receipts: (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [g.connection.id])).rows[0].n as number });
  // Failure after the debit, receipt and effect rolls back ALL of them, including the contribution and its native receipt.
  await assert.rejects(g.run(update, saveBlocker, true), /injected failure after debit/);
  assert.deepEqual([await g.counts(), await ledger()], [base, { uses: 0, receipts: 0 }]);
  const first = await g.run(update, saveBlocker);
  assert.deepEqual(await ledger(), { uses: 1, receipts: 1 });
  const read = await g.discussion(g.reader, t.id);
  assert.deepEqual([read.root?.body, read.root?.contribution, read.root?.authorId, read.root?.author?.id, read.root?.author?.kind],
    ['Ledger blocker', { kind: 'blocker' }, null, g.agent.id, 'agent']);
  assert.deepEqual(delta(await g.counts(), base), { messages: 1, conversations: 1, bindings: 1, results: 0, receipts: 1, events: 2, search: 1 });
  // A matching retry replays the ledger value: no effect, no second message, no second debit, no second event.
  const afterFirst = await g.counts();
  assert.deepEqual(await g.run(update, saveBlocker), first);
  assert.deepEqual([await g.counts(), await ledger(), g.effects()], [afterFirst, { uses: 1, receipts: 1 }, 2]);
  // Changed produced state stays stale, never a second contribution.
  expectStatus(await g.patch(g.owner, t.id, { title: 'Someone moved the task' }, (first as { version: number }).version), 200);
  await assert.rejects(g.run(update, saveBlocker), (error: unknown) => error instanceof DomainError && error.code === 'COMMAND_POSTSTATE_STALE');
  assert.equal((await g.discussion(g.reader, t.id)).messages.length, 1);

  const record: AgentExecutionCommand = { runtimeSessionId: g.runtime.id, grantId: g.resultGrant.id, clientCommandId: randomUUID(), projectId: g.place.id,
    operation: 'result.record', peerRequestClass: 'execute', audience: { kind: 'project', projectId: g.place.id }, objectId: null, sources: [],
    payload: { title: 'Ledger result', work: [u.id, t.id] } };
  const publish = (native: ReturnType<typeof nativeWorkInTransaction>) => native.createResult(g.principal, g.place.id,
    { title: 'Ledger result', finding: 'positive', work: [u.id, t.id], clientCommandId: record.clientCommandId })
    .then((view) => ({ value: { resultId: view.id } as AgentJsonValue, postconditions: [{ kind: 'result' as const, id: view.id }] }));
  const beforeResult = await g.counts();
  const published = await g.run(record, publish) as { resultId: string };
  assert.deepEqual(delta(await g.counts(), beforeResult), { messages: 2, conversations: 1, bindings: 1, results: 1, receipts: 1, events: 3, search: 2 });
  for (const task of [t, u]) {
    const message = (await g.discussion(g.reader, task.id)).messages.at(-1)!;
    assert.deepEqual([message.contribution, message.authorId, message.author?.id], [{ kind: 'result', resultId: published.resultId }, null, g.agent.id]);
  }
  const afterResult = await g.counts();
  assert.deepEqual(await g.run(record, publish), published);
  assert.deepEqual(await g.counts(), afterResult);
  assert.equal(g.effects(), 3, 'no replay executed an effect');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM native_command_receipts WHERE actor_kind=$1 AND actor_id=$2', ['agent', g.agent.id])).rows[0].n, 2);
});

test('the receipt and message constraints refuse a result reference out of scope and a receipt without its produced object', async () => {
  const f = await scene();
  const t = await f.task('Constraint task');
  const other = await project(f.owner, f.ws.id, 'Other project', 'restricted');
  const foreign = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${other.id}/results`, { body: { title: 'Foreign result', finding: 'positive' } }), 201) as WorkResult;
  const made = expectStatus(await f.result(f.owner, { title: 'Real result', finding: 'positive', work: [t.id] }), 201) as WorkResult;
  const read = await f.discussion(f.owner, t.id);
  const message = read.root!;
  const row = (await pool.query('SELECT * FROM project_messages WHERE id=$1', [message.id])).rows[0];
  const insert = (kind: string, resultId: string | null, projectId = f.place.id) => pool.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,
    request_fingerprint,sequence,body,contribution_kind,result_id) VALUES($1,$2,$3,$4,$5,$6,'x',99,'x',$7,$8)`,
  [randomUUID(), f.ws.id, projectId, message.conversationId, f.owner.id, randomUUID(), kind, resultId]);
  await assert.rejects(insert('result', null), /project_message_result_reference/);
  await assert.rejects(insert('blocker', made.id), /project_message_result_reference/);
  await assert.rejects(insert('result', foreign.id), /project_message_result_scope|foreign key/);
  await assert.rejects(insert('ack', null), /project_message_contribution_kind/);
  await assert.rejects(pool.query('UPDATE project_messages SET result_id=$2 WHERE id=$1', [message.id, foreign.id]), /foreign key|violates/);
  assert.equal(row.contribution_kind, 'result');
  assert.equal(row.result_id, made.id);
  const receipt = (operation: string, workId: string | null, version: number | null, resultId: string | null) => pool.query(`INSERT INTO native_command_receipts(workspace_id,project_id,
    actor_kind,actor_id,operation,client_command_id,request_fingerprint,work_id,work_version,result_id) VALUES($1,$2,'human',$3,$4,$5,'x',$6,$7,$8)`,
  [f.ws.id, f.place.id, f.owner.id, operation, randomUUID(), workId, version, resultId]);
  await assert.rejects(receipt('work.update', null, null, null), /violates check constraint/);
  await assert.rejects(receipt('work.update', t.id, null, null), /violates check constraint/);
  await assert.rejects(receipt('work.update', t.id, 1, made.id), /violates check constraint/);
  await assert.rejects(receipt('result.create', t.id, 1, made.id), /violates check constraint/);
  await assert.rejects(receipt('result.create', null, null, foreign.id), /foreign key/);
  await assert.rejects(receipt('result.refund', null, null, made.id), /violates check constraint/);
  await receipt('result.create', null, null, made.id);
  assert.ok((await db.select().from(schema.nativeCommandReceipts).where(eq(schema.nativeCommandReceipts.resultId, made.id))).length >= 1);
});

test('blocker and result contributions finish every domain, receipt and response write before one final event batch', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Final batch task'), await f.task('Second final batch task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const events = await db.transaction(async (tx) => {
    const guarded = guardFinalEventPhase(tx);
    const session = nativeWorkInTransaction(guarded.tx);
    await session.updateWork(human(f.writer), t.id, { blocker: 'Batch blocker', clientCommandId: randomUUID() }, blocked.version);
    await session.createResult(human(f.writer), f.place.id, { title: 'Batch result', finding: 'positive', work: [u.id, t.id], clientCommandId: randomUUID() });
    assert.equal(guarded.started, false, 'no event was inserted while the work, appends and receipts were prepared');
    assert.equal(session.eventIntents.length, 5);
    const staged = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND classid=((hashtext('flux.events.seq')::bigint >> 32) & 4294967295)::oid
      AND objid=(hashtext('flux.events.seq')::bigint & 4294967295)::oid AND objsubid=1) AS stream_lock`);
    assert.equal(staged.rows[0]!.stream_lock, false, 'the stream lock is taken only by the final flush');
    const flushed = await session.flushEvents();
    assert.equal(guarded.started, true);
    return flushed;
  });
  assert.equal(events.length, 5);
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
    for (const path of [`/api/v1/work/${t.id}/discussion`, `/api/v1/work/${t.id}`, `/api/v1/projects/${f.place.id}/work`, `/api/v1/projects/${f.place.id}/results`]) {
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
  assert.deepEqual(delta(await f.counts(), before), { messages: 0, conversations: 0, bindings: 0, results: 0, receipts: 0, events: 1, search: 0 });
  const notices = expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/task-notices`), 200) as { items: Array<{ workId: string; kind: string }> };
  assert.deepEqual(notices.items.filter((item) => item.workId === created.id).map((item) => item.kind), ['task.created']);
  assert.equal((await f.discussion(f.reader, created.id)).root, null);
  // Saving that same blocker explicitly later IS a contribution.
  expectStatus(await f.patch(f.writer, created.id, { blocker: 'Waiting for the supplier', clientCommandId: randomUUID() }, created.version), 200);
  assert.equal((await f.discussion(f.reader, created.id)).root?.body, 'Waiting for the supplier');
});

test('concurrent exact duplicates of a keyed save or a keyed publication share one contribution and one outcome', async () => {
  const f = await scene();
  const [t, u] = [await f.task('Duplicate task'), await f.task('Second duplicate task')];
  const blocked = expectStatus(await f.patch(f.owner, t.id, { status: 'blocked' }, 1), 200) as WorkItem;
  const base = await f.counts();
  const save = { blocker: 'Duplicate blocker', clientCommandId: randomUUID() };
  const saves = await Promise.all(Array.from({ length: 4 }, () => f.patch(f.writer, t.id, save, blocked.version)));
  const bodies = saves.map((response) => expectStatus(response, 200) as WorkItem);
  assert.equal(new Set(bodies.map((item) => item.version)).size, 1);
  const publication = { title: 'Duplicate result', finding: 'positive', work: [t.id, u.id], clientCommandId: randomUUID() };
  const publications = (await Promise.all(Array.from({ length: 4 }, () => f.result(f.writer, publication)))).map((response) => expectStatus(response, 201) as WorkResult);
  assert.equal(new Set(publications.map((item) => item.id)).size, 1);
  assert.deepEqual(delta(await f.counts(), base), { messages: 3, conversations: 2, bindings: 2, results: 1, receipts: 2, events: 5, search: 3 });
});

// ---- the effects coexist with the native task graph (#152 plan, migration 0039) ----

test('a finishing result and a start honor prerequisites: unmet ones write nothing, met ones finish and contribute', async () => {
  const f = await scene();
  const [pre, dependent] = [await f.task('Prerequisite'), await f.task('Dependent')];
  const linked = expectStatus(await f.patch(f.owner, dependent.id, { dependencyIds: [pre.id] }, dependent.version), 200) as WorkItem;
  assert.deepEqual(linked.dependencyIds, [pre.id]);
  const base = await f.counts();
  const early = await f.result(f.writer, { title: 'Too early', finding: 'positive', work: [dependent.id],
    finishes: { id: dependent.id, expectedVersion: linked.version }, clientCommandId: randomUUID() });
  assert.deepEqual([early.status, code(early)], [409, 'TASK_PREREQUISITES_UNMET']);
  const start = await f.patch(f.writer, dependent.id, { status: 'in_progress', blocker: null, clientCommandId: randomUUID() }, linked.version);
  assert.deepEqual([start.status, code(start)], [409, 'TASK_PREREQUISITES_UNMET']);
  assert.deepEqual(await f.counts(), base, 'a refused finish or start leaves no result, message, thread, receipt or event');
  // A blocker save does not start the task, so it is not a graph transition and contributes normally.
  const blocked = expectStatus(await f.patch(f.writer, dependent.id, { status: 'blocked', blocker: 'Waiting for the prerequisite', clientCommandId: randomUUID() }, linked.version), 200) as WorkItem;
  assert.equal((await f.discussion(f.reader, dependent.id)).root?.contribution?.kind, 'blocker');
  expectStatus(await f.patch(f.owner, pre.id, { status: 'done' }, pre.version), 200);
  const finished = expectStatus(await f.result(f.writer, { title: 'Done after its prerequisite', finding: 'positive', work: [dependent.id],
    finishes: { id: dependent.id, expectedVersion: blocked.version }, clientCommandId: randomUUID() }), 201) as WorkResult;
  assert.equal((await f.current(dependent.id)).status, 'done');
  const thread = await f.discussion(f.reader, dependent.id);
  assert.deepEqual(thread.messages.map((row) => [row.sequence, row.contribution]), [[1, { kind: 'blocker' }], [2, { kind: 'result', resultId: finished.id }]]);
});

test('a finishing result locks the linked tasks and the finishing task\'s prerequisites in ONE ascending pass', async () => {
  const f = await scene();
  const made = [await f.task('Order A'), await f.task('Order B'), await f.task('Order C')].sort((x, y) => (x.id < y.id ? -1 : 1)) as [WorkItem, WorkItem, WorkItem];
  const [a, b, c] = made;
  expectStatus(await f.patch(f.owner, c.id, { status: 'done' }, c.version), 200);
  const dependent = expectStatus(await f.patch(f.owner, b.id, { dependencyIds: [c.id] }, b.version), 200) as WorkItem;
  let pending!: ReturnType<typeof f.result>;
  await db.transaction(async (tx) => {
    // Hold the HIGHEST task, a prerequisite of the finishing task b. A result linking [b, a] must already hold
    // both lower tasks before it waits: a separate prerequisite pass would hold only b and leave a free.
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${c.id} FOR UPDATE`);
    const holder = await backendPid(tx);
    pending = f.result(f.writer, { title: 'One ascending pass', finding: 'positive', work: [b.id, a.id],
      finishes: { id: b.id, expectedVersion: dependent.version }, clientCommandId: randomUUID() });
    await waitUntilBlockedBy(pool, holder);
    for (const id of [a.id, b.id]) {
      await assert.rejects(pool.query('SELECT 1 FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [id]), /could not obtain lock/, 'held before the wait');
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 0);
  });
  expectStatus(await pending, 201);
  assert.equal((await f.current(b.id)).status, 'done');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 2);
});

test('a helper acceptance that finishes a task takes the graph lock before the task row and fences the version it authorized', async () => {
  const f = await scene();
  const unit = proposalUnitOfWork(db, new FakeQueue().factory);
  // Only the acceptance's lock order and fence are under test: the helper run and proposal rows (#68) are stood in for.
  const decide = (proposal: ProposalRecord) => createAssistantProposalUseCases({ run: (action) => unit.run((ports) => action({ ...ports,
    runs: { ...ports.runs, findProposal: async () => proposal,
      updateProposal: async (_id, changes) => ({ ...proposal, ...changes, version: proposal.version + 1 }) } })) });
  const proposalFor = (work: WorkItem): ProposalRecord => ({ id: randomUUID(), workspaceId: f.ws.id, projectId: f.place.id, runId: randomUUID(),
    ownerUserId: f.owner.id, fact: 'Measured at the bench', interpretation: 'It holds', resultTitle: `Accepted: ${work.title}`, resultFinding: 'positive',
    resultEvidence: '', finishesWorkId: work.id, status: 'proposed', decidedBy: null, decidedAt: null, resultId: null, version: 1,
    createdAt: new Date(), updatedAt: new Date() });
  const graphLock = sql`SELECT pg_advisory_xact_lock(hashtextextended(${TASK_GRAPH_LOCK_NAMESPACE + f.place.id}, 0))`;

  // A graph writer holds the graph lock and then takes the task row; the waiting acceptance must not already hold it.
  const t = await f.task('Accepted task');
  const proposal = proposalFor(t);
  let accepted!: Promise<AssistantProposal>;
  await db.transaction(async (tx) => {
    await tx.execute(graphLock);
    const holder = await backendPid(tx);
    accepted = decide(proposal).accept(human(f.owner), proposal.id, {}, 1);
    await waitUntilBlockedBy(pool, holder);
    await tx.execute(sql`SELECT 1 FROM project_work_items WHERE id=${t.id} FOR UPDATE NOWAIT`);
  });
  const view = await accepted;
  assert.equal(view.status, 'accepted');
  assert.equal((await f.current(t.id)).status, 'done');
  assert.deepEqual((await f.discussion(f.reader, t.id)).root?.contribution, { kind: 'result', resultId: view.resultId });

  // The owner check is not weakened: a change to the task after the authority read is a version conflict that writes nothing.
  const owned = await f.task('Owned task');
  const mine = expectStatus(await f.patch(f.owner, owned.id, { owner: { kind: 'human', id: f.writer.id } }, owned.version), 200) as WorkItem;
  const second = proposalFor(mine);
  const before = await f.counts();
  let refused!: Promise<unknown>;
  await db.transaction(async (tx) => {
    await tx.execute(graphLock);
    const holder = await backendPid(tx);
    refused = decide(second).accept(human(f.writer), second.id, {}, 1).catch((error: unknown) => error);
    await waitUntilBlockedBy(pool, holder);
    await tx.execute(sql`UPDATE project_work_items SET owner_user_id=${f.owner.id}, version=version+1 WHERE id=${owned.id}`);
  });
  const error = await refused;
  assert.ok(error instanceof DomainError && error.code === 'VERSION_CONFLICT', String(error));
  assert.deepEqual(await f.counts(), before);
  assert.equal((await f.current(owned.id)).status, 'open');
});

test('replacing prerequisites and saving a blocker in one keyed command is one outcome: exact replay, set semantics, changed intent conflicts', async () => {
  const f = await scene();
  const [t, first, second] = [await f.task('Planned'), await f.task('First prerequisite'), await f.task('Second prerequisite')];
  const command = { status: 'blocked', blocker: 'Waiting for both prerequisites', dependencyIds: [first.id, second.id], clientCommandId: randomUUID() };
  const base = await f.counts();
  const saved = expectStatus(await f.patch(f.writer, t.id, command, t.version), 200) as WorkItem;
  assert.deepEqual(saved.dependencyIds, [first.id, second.id].sort());
  assert.deepEqual(delta(await f.counts(), base), { messages: 1, conversations: 1, bindings: 1, results: 0, receipts: 1, events: 2, search: 1 });
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
