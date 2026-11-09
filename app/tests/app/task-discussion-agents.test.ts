import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { assistantChangeActionPath, conversationAssistantChangesPath, type AssistantChange, type AssistantChangeDecision, type TaskDiscussion, type WorkItem } from '@flux/contracts';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { db, pool } from './support/db.js';

// #868: a task has one discussion, where people and agents write. The agent's tools are flux_discuss_task and flux_get_task_discussion.
type Scene = Awaited<ReturnType<typeof actionScene>>;
const task = async (f: Scene, title = 'Measure the lamp') =>
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title } }), 201) as unknown as WorkItem;
const discuss = (f: Scene, taskId: string, body = 'One meaningful step.', clientCommandId: string = randomUUID()) =>
  f.tool('flux_discuss_task', { projectId: f.projectId, taskId, runtimeSessionId: f.runtimeSessionId, clientCommandId, peerRequestClass: 'execute', sources: [], body });
const discussion = async (f: Scene, taskId: string) => expect(await f.owner.request('GET', `/api/v1/work/${taskId}/discussion`), 200) as unknown as TaskDiscussion;
const personWrites = async (f: Scene, taskId: string, body = 'Go on.') =>
  expect(await f.owner.request('POST', `/api/v1/work/${taskId}/discussion`, { body: { body, clientMessageId: randomUUID() } }), 201);
type Client = { tool: Scene['tool']; runtimeSessionId: string };
const envelope = (f: Scene, client: Client) => ({ projectId: f.projectId, runtimeSessionId: client.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [] });
/** Every way an agent's words reach a task's discussion: its own tool, and a reply or a question in its conversation. */
const writes = (f: Scene, client: Client, taskId: string, conversationId: string) => ({
  discuss: (body: string) => client.tool('flux_discuss_task', { ...envelope(f, client), taskId, body }),
  reply: (body: string) => client.tool('flux_reply_in_conversation', { ...envelope(f, client), conversationId, message: { body } }),
  ask: (body: string) => client.tool('flux_ask_question', { ...envelope(f, client), conversationId, question: body, options: ['Yes', 'No'] }),
});

test('an agent writes in the task\'s one discussion and reads it; people read the same messages there, and a replay adds nothing', async () => {
  const f = await actionScene(pool), item = await task(f);
  const names = await f.toolNames();
  assert.ok(names.includes('flux_discuss_task') && names.includes('flux_get_task_discussion'));
  assert.ok(!names.includes('flux_post_agent_thread') && !names.includes('flux_get_agent_thread'), 'the agents\' thread is gone');
  const command = '11111111-1111-4111-8111-111111111111';
  const first = toolValue(await discuss(f, item.id, 'Plan: measure twice.', command));
  assert.equal(first.sequence, 1); assert.equal(first.replayed, false);
  assert.deepEqual(toolValue(await discuss(f, item.id, 'Plan: measure twice.', command)), { ...first, replayed: true });
  const second = toolValue(await discuss(f, item.id, 'Progress: baseline measured.'));
  assert.equal(second.conversationId, first.conversationId, 'the same discussion');

  // A person reads both messages in the task's discussion, written as the agent, and answers there.
  const people = await discussion(f, item.id);
  assert.deepEqual(people.messages.map((message) => [message.sequence, message.body]), [[1, 'Plan: measure twice.'], [2, 'Progress: baseline measured.']]);
  assert.equal(people.messages[0]!.authorId, null);
  assert.equal(people.messages[0]!.author.id, f.agentId);
  expect(await f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { body: 'Thanks, go on.', clientMessageId: randomUUID() } }), 201);
  const read = toolValue(await f.tool('flux_get_task_discussion', { taskId: item.id })) as unknown as TaskDiscussion;
  assert.deepEqual(read.messages.map((message) => message.sequence), [1, 2, 3]);
  const page = toolValue(await f.tool('flux_get_task_discussion', { taskId: item.id, limit: 1 })) as unknown as TaskDiscussion;
  assert.deepEqual(page.messages.map((message) => message.sequence), [3]);
  assert.equal(page.messagePage.hasMoreBefore, true);

  // It is a conversation of the task, not a second thread: the stream lists no root for it.
  const roots = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/conversation-roots`), 200) as unknown as { roots: unknown[] };
  assert.equal(roots.roots.length, 0, 'a task\'s discussion is a line in the stream, not a root');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_discussions WHERE work_id = $1', [item.id])).rows[0].n, 1);
});

test('the tools reach only the owner\'s own spaces; Only read refuses the write and the read tool still answers', async () => {
  const f = await actionScene(pool), item = await task(f);
  assert.deepEqual((await discussion(f, item.id)).messages, []);
  // Another person's space is not a destination and not readable: the client has its owner's rights and no more.
  const stranger = await actionScene(pool);
  const other = expect(await stranger.owner.request('POST', `/api/v1/projects/${stranger.projectId}/work`, { body: { title: 'Elsewhere task' } }), 201);
  assert.equal(toolFailure(await discuss(f, String(other.id))).code, 'OBJECT_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_get_task_discussion', { taskId: other.id })).code, 'PROJECT_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_get_task_discussion', { taskId: randomUUID() })).code, 'PROJECT_NOT_FOUND');
  // An agent set to Only read still lists the write tool, and a call to it is refused; the read tool answers.
  expect(await f.owner.request('PATCH', `/api/v1/agent-connections/${f.connectionId}`, { body: { mayDo: 'read' } }), 200);
  const names = await f.toolNames();
  assert.ok(names.includes('flux_discuss_task') && names.includes('flux_get_task_discussion'));
  await f.raw('flux_discuss_task', { projectId: f.projectId, taskId: item.id, body: 'x' });
  assert.deepEqual((await discussion(f, item.id)).messages, []);
  assert.deepEqual((toolValue(await f.tool('flux_get_task_discussion', { taskId: item.id })) as unknown as TaskDiscussion).messages, []);
});

test('the sixth agent message in a row is refused until a person writes; then it is accepted again', async () => {
  const f = await actionScene(pool), item = await task(f);
  for (let i = 1; i <= 5; i++) toolValue(await discuss(f, item.id, `Step ${i}`));
  assert.equal(toolFailure(await discuss(f, item.id, 'Step 6')).code, 'AGENT_TURN_LIMIT');
  assert.equal((await discussion(f, item.id)).messages.length, 5);
  expect(await f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { body: 'Go on.', clientMessageId: randomUUID() } }), 201);
  assert.equal(toolValue(await discuss(f, item.id, 'Step 6')).sequence, 7);
  // Only a person's message gives an agent more messages.
  for (let i = 7; i <= 10; i++) toolValue(await discuss(f, item.id, `Step ${i}`));
  assert.equal(toolFailure(await discuss(f, item.id, 'Step 11')).code, 'AGENT_TURN_LIMIT');
});

test('#868: the line at Done is not refused by the five-in-a-row limit: the Done and the task\'s line stand, and no sixth message is written', async () => {
  const f = await actionScene(pool), item = await task(f);
  for (let i = 1; i <= 5; i++) toolValue(await discuss(f, item.id, `Step ${i}`));
  assert.equal(toolFailure(await discuss(f, item.id, 'Step 6')).code, 'AGENT_TURN_LIMIT');
  const done = toolValue(await f.tool('flux_update_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute',
    sources: [], workId: item.id, expectedVersion: item.version, changes: { status: 'done', cameOfIt: 'Measured twice; it holds.' } }));
  assert.ok(done.workId);
  const stored = expect(await f.owner.request('GET', `/api/v1/work/${item.id}`), 200) as unknown as WorkItem;
  assert.deepEqual([stored.status, stored.cameOfIt], ['done', 'Measured twice; it holds.']);
  assert.equal((await discussion(f, item.id)).messages.length, 5, 'the limit still holds for messages');
});

test('flux_reply_in_conversation into a people\'s conversation keeps its contract-1 behaviour', async () => {
  const f = await actionScene(pool);
  const plain = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Status?', clientMessageId: randomUUID() } }), 201);
  const sent = toolValue(await f.tool('flux_reply_in_conversation', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], conversationId: String(plain.id), message: { body: 'Fine.' } }));
  assert.equal(sent.sequence, 2);
});

test('C-51: after five agent messages in a row every way of writing in the discussion is refused, and nothing is written, until a person writes', async () => {
  const f = await actionScene(pool), item = await task(f);
  const conversationId = String(toolValue(await discuss(f, item.id, 'Step 1')).conversationId);
  for (let i = 2; i <= 5; i++) toolValue(await discuss(f, item.id, `Step ${i}`));
  const by = writes(f, f, item.id, conversationId);
  for (const [path, write] of Object.entries(by))
    assert.equal(toolFailure(await write(`A sixth line by ${path}`)).code, 'AGENT_TURN_LIMIT', `${path} is refused`);
  assert.deepEqual((await discussion(f, item.id)).messages.map((message) => message.body), ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_questions WHERE conversation_id = $1', [conversationId])).rows[0].n, 0, 'nor the question');
  // A person's message gives the agents their turns back, on every path.
  await personWrites(f, item.id);
  for (const write of Object.values(by)) toolValue(await write('After the person'));
  assert.equal((await discussion(f, item.id)).messages.length, 9);
});

test('C-51: two agents taking turns, with any tools, share the five messages; a line Flux writes for an agent is neither counted nor refused', async () => {
  const f = await actionScene(pool), item = await task(f);
  const second = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`, { body: { name: 'Reviewing agent', owner: 'self' } }), 201);
  const other = await agentConnection(pool, f.owner, String(second.id), [f.projectId]);
  await personWrites(f, item.id, 'Please both look at it.');
  const conversationId = String((await discussion(f, item.id)).conversationId);
  const a = writes(f, f, item.id, conversationId), b = writes(f, other, item.id, conversationId);
  for (const write of [a.discuss, b.reply, a.reply, b.discuss, a.discuss]) toolValue(await write('Back and forth'));
  assert.equal(toolFailure(await b.discuss('One more from B')).code, 'AGENT_TURN_LIMIT');
  assert.equal(toolFailure(await a.reply('One more from A')).code, 'AGENT_TURN_LIMIT');
  // The server's own line for an agent at work on the task (a run's report, a status line) is always written, and gives no turn back.
  const flux = (body: string) => taskDiscussionUseCases(db).contribute({ kind: 'agent', id: f.agentId }, item.id, { body, clientMessageId: randomUUID() }, { byFlux: true });
  assert.equal((await flux('Done: measured both lamps.')).body, 'Done: measured both lamps.');
  assert.equal(toolFailure(await b.discuss('Still waiting for a person')).code, 'AGENT_TURN_LIMIT');
  await personWrites(f, item.id);
  // Nor does it count: three tool lines, two of Flux's, then two more tool lines make five.
  for (const step of [a.discuss, b.discuss, a.reply]) toolValue(await step('Counted'));
  await flux('Stopped by Ada.'); await flux('I couldn\'t finish this.');
  for (const step of [b.reply, a.discuss]) toolValue(await step('Counted'));
  assert.equal(toolFailure(await b.discuss('The sixth')).code, 'AGENT_TURN_LIMIT');
  assert.deepEqual((await pool.query(`SELECT by_flux FROM project_messages WHERE conversation_id = $1 ORDER BY sequence`, [conversationId])).rows.filter((row) => row.by_flux).length, 3);
});

test('#961, C-51: a line written with flux_discuss_task is its owner\'s to delete, as one written with flux_reply_in_conversation', async () => {
  const f = await actionScene(pool), item = await task(f);
  const name = String((await pool.query('SELECT name FROM auth_users WHERE id = (SELECT owner_user_id FROM agent_connections WHERE id = $1)', [f.connectionId])).rows[0].name);
  const command = randomUUID();
  const line = toolValue(await discuss(f, item.id, 'The baseline is four hours.', command));
  assert.equal(toolValue(await discuss(f, item.id, 'The baseline is four hours.', command)).replayed, true);
  const conversationId = String(line.conversationId);
  const reply = toolValue(await writes(f, f, item.id, conversationId).reply('And the lamp draws 3 W.'));
  // A person answers both; a line in a task's discussion is deleted by its owner whatever came after (TA-3).
  await personWrites(f, item.id, 'Good, thanks');
  const changes = (expect(await f.owner.request('GET', conversationAssistantChangesPath(conversationId)), 200) as unknown as { items: AssistantChange[] }).items;
  const of = (messageId: unknown) => changes.filter((change) => change.operation === 'conversation.reply' && change.objectId === String(messageId));
  assert.equal(of(line.messageId).length, 1, 'one change for the line, however often the call is retried');
  assert.equal(of(reply.messageId).length, 1);
  const rows = (await pool.query(`SELECT tool, connection_id, conversation_id, receipt->'undo'->'plan' AS plan FROM assistant_changes WHERE object_id = ANY($1) ORDER BY tool`,
    [[line.messageId, reply.messageId]])).rows;
  assert.deepEqual(rows.map((row) => [row.tool, row.connection_id, row.conversation_id, row.plan]), [
    ['flux_discuss_task', f.connectionId, conversationId, { kind: 'removal', thread: true }],
    ['flux_reply_in_conversation', f.connectionId, conversationId, { kind: 'removal', thread: true }]], 'recorded the same way');
  const change = of(line.messageId)[0]!;
  assert.ok(change.undoable, 'its owner is offered the delete');
  const deleted = expect(await f.owner.request('POST', assistantChangeActionPath(change.id, 'undo'), { body: {} }), 200) as unknown as AssistantChangeDecision;
  assert.deepEqual([deleted.message, deleted.change.state, deleted.change.line], [null, 'undone', `Removed by ${name}`]);
  const bodies = (await discussion(f, item.id)).messages.map((message) => message.body);
  assert.ok(bodies.includes('[Removed]') && !bodies.includes('The baseline is four hours.'), 'a marker keeps its place');
  assert.ok(bodies.includes('And the lamp draws 3 W.') && bodies.includes('Good, thanks'));
  assert.ok(!JSON.stringify((await pool.query('SELECT receipt, object_title FROM assistant_changes WHERE id = $1', [change.id])).rows[0]).includes('baseline is four'), 'nothing of the text is left in the change');
});
