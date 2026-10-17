import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ConversationMessage, TaskAgentThread, WorkItem } from '@flux/contracts';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { pool } from './support/db.js';

type Scene = Awaited<ReturnType<typeof actionScene>>;
const task = async (f: Scene, title = 'Measure the lamp') =>
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title } }), 201) as unknown as WorkItem;
const post = (f: Scene, taskId: string, grantId: string, body = 'One meaningful step.', clientCommandId: string = randomUUID()) =>
  f.tool('flux_post_agent_thread', { projectId: f.projectId, taskId, runtimeSessionId: f.runtimeSessionId, grantId, clientCommandId,
    peerRequestClass: 'execute', sources: [], body });
const thread = async (f: Scene, taskId: string) => expect(await f.owner.request('GET', `/api/v1/work/${taskId}/agent-thread`), 200) as unknown as TaskAgentThread;

test('an agent writes and reads the task thread; people see it only there, and a replay adds nothing', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 20);
  assert.ok((await f.toolNames()).includes('flux_get_agent_thread'));
  const first = toolValue(await post(f, item.id, grant.id, 'Plan: measure twice.', '11111111-1111-4111-8111-111111111111'));
  assert.equal(first.sequence, 1); assert.equal(first.replayed, false);
  assert.deepEqual(toolValue(await post(f, item.id, grant.id, 'Plan: measure twice.', '11111111-1111-4111-8111-111111111111')), { ...first, replayed: true });
  assert.equal((await thread(f, item.id)).messageCount, 1);
  const people = await thread(f, item.id);
  assert.equal(people.conversation!.messages[0]!.authorId, null);
  assert.equal(people.conversation!.messages[0]!.author.id, f.agentId);
  // The same thread, read as the agent: paging by afterSequence returns what follows the recorded one.
  const second = toolValue(await post(f, item.id, grant.id, 'Progress: baseline measured.'));
  const read = toolValue(await f.tool('flux_get_agent_thread', { taskId: item.id, afterSequence: 1 })) as unknown as { messages: ConversationMessage[]; messageCount: number };
  assert.deepEqual(read.messages.map((m) => [m.sequence, m.id]), [[2, second.messageId]]);
  assert.equal(read.messageCount, 2);
  const all = toolValue(await f.tool('flux_get_agent_thread', { taskId: item.id })) as unknown as { messages: ConversationMessage[] };
  assert.equal(all.messages.length, 2);
  // Quiet: not a people's conversation, no message event for the stream's people lists, no notification.
  const list = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/conversations`), 200) as unknown as { total: number };
  assert.equal(list.total, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE url LIKE $1', [`%${first.messageId}`])).rows[0].n, 0);
  assert.equal((expect(await f.owner.request('GET', `/api/v1/work/${item.id}/discussion`), 200) as unknown as { messages: unknown[] }).messages.length, 0);
});

test('the post tool needs its grant, the selected project and the scope; reading needs the context scope', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 20);
  // No grant for this operation: refused, nothing written, nothing debited.
  const planOnly = await f.grant('conversation.create', 'execute', 5);
  assert.equal(toolFailure(await post(f, item.id, planOnly.id)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal((await thread(f, item.id)).messageCount, 0);
  // An unselected project is not a destination and not readable.
  const elsewhere = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`, { body: { name: 'Elsewhere', visibility: 'restricted' } }), 201);
  const other = expect(await f.owner.request('POST', `/api/v1/projects/${elsewhere.id}/work`, { body: { title: 'Elsewhere task' } }), 201);
  assert.equal(toolFailure(await post(f, String(other.id), grant.id)).code, 'OBJECT_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_get_agent_thread', { taskId: other.id })).code, 'PROJECT_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_get_agent_thread', { taskId: randomUUID() })).code, 'PROJECT_NOT_FOUND');
  // A connection without the action scope neither lists nor runs the post tool; the context scope still reads.
  const reader = await agentConnection(pool, f.owner, f.agentId, [f.projectId], ['flux.context.read']);
  const names = await reader.toolNames();
  assert.ok(!names.includes('flux_post_agent_thread') && names.includes('flux_get_agent_thread'));
  await reader.raw('flux_post_agent_thread', { projectId: f.projectId, taskId: item.id, body: 'x' });
  assert.equal((await thread(f, item.id)).messageCount, 0);
});

test('the sixth agent message in a row is refused until a person writes; then it is accepted again', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 30);
  for (let i = 1; i <= 5; i++) toolValue(await post(f, item.id, grant.id, `Step ${i}`));
  assert.equal(toolFailure(await post(f, item.id, grant.id, 'Step 6')).code, 'AGENT_THREAD_TURN_LIMIT');
  assert.equal((await thread(f, item.id)).messageCount, 5);
  expect(await f.owner.request('POST', `/api/v1/work/${item.id}/agent-thread`, { body: { body: 'Go on.', clientMessageId: randomUUID() } }), 201);
  assert.equal(toolValue(await post(f, item.id, grant.id, 'Step 6')).sequence, 7);
});

test('flux_reply_in_conversation into a people\'s conversation keeps its contract-1 behaviour', async () => {
  const f = await actionScene(pool), grant = await f.grant('conversation.reply', 'execute', 10);
  const plain = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Status?', clientMessageId: randomUUID() } }), 201);
  const sent = toolValue(await f.tool('flux_reply_in_conversation', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: grant.id,
    clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], conversationId: String(plain.id), message: { body: 'Fine.' } }));
  assert.equal(sent.sequence, 2);
});
