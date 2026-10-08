import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation, ConversationMessage, Doc, TaskDiscussion } from '@flux/contracts';
import { conversationUseCases, InvalidInputError } from '@flux/core';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { db, pool } from './support/db.js';
import { register, uniqueEmail } from './support/http.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';

type Scene = Awaited<ReturnType<typeof actionScene>>;
type Connection = Pick<Scene, 'runtimeSessionId' | 'tool'>;
const messages = async (conversationId: string) => (await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [conversationId])).rows[0].n as number;
const projectMessages = async (projectId: string) => (await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [projectId])).rows[0].n as number;
const messageEvents = async (conversationId: string) => (await pool.query(
  "SELECT count(*)::int AS n FROM events WHERE kind IN ('project.conversation_created.v1', 'project.message_sent.v1') AND data->>'conversationId' = $1",
  [conversationId])).rows[0].n as number;
const command = (projectId: string, connection: Connection, grantId: string, peerRequestClass: 'execute' | 'plan' = 'plan', clientCommandId: string = randomUUID()) => ({
  projectId, runtimeSessionId: connection.runtimeSessionId, grantId, clientCommandId, peerRequestClass, sources: [] as { materialId: string; version: number }[] });
const read = async (f: Scene, conversationId: string) => expect(await f.owner.request('GET', `/api/v1/conversations/${conversationId}`), 200) as unknown as Conversation;

test('standing conversation grants start a project conversation and reply in a thread as the agent: one message, event and debit per command', async () => {
  const f = await actionScene(pool);
  const capabilities = f.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation?.startsWith('conversation.')).map(({ name, operation, classes, available }) => ({ name, operation, classes, available })),
    [{ name: 'flux_start_conversation', operation: 'conversation.create', classes: ['execute', 'plan'], available: true },
      { name: 'flux_reply_in_conversation', operation: 'conversation.reply', classes: ['execute', 'plan'], available: true }]);
  const start = await f.grant('conversation.create', 'plan');
  const reply = await f.grant('conversation.reply', 'execute', 10);
  const first = randomUUID();
  const opening = { ...command(f.projectId, f, start.id, 'plan', first), sources: [f.source],
    message: { body: 'The baseline holds at four hours.', cite: f.source } };
  const started = toolValue(await f.tool('flux_start_conversation', opening));
  const conversationId = String(started.conversationId);
  assert.deepEqual([started.sequence, started.replayed], [1, false]);
  let conversation = await read(f, conversationId);
  const agent = { kind: 'agent', id: f.agentId, name: 'Planning agent' };
  const ownerId = (expect(await f.owner.request('GET', '/api/v1/me'), 200) as unknown as { user: { id: string } }).user.id;
  assert.deepEqual([conversation.audience, conversation.createdBy, conversation.createdByActor], [{ kind: 'project', projectId: f.projectId }, null, agent]);
  assert.deepEqual(conversation.messages.map((item) => [item.id, item.authorId, item.author, item.body, item.source]),
    [[started.messageId, null, { ...agent, projectOwner: { kind: 'human', id: ownerId } }, 'The baseline holds at four hours.', f.source]],
    'the agent is the real author; its current-project owner is optional read metadata');
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId), await f.used(start.id)], [1, 1, 1]);

  // A lost response is retried with the same command ID: the stored outcome, no second conversation, message, event or debit.
  assert.deepEqual(toolValue(await f.tool('flux_start_conversation', opening)), { ...started, replayed: true });
  assert.deepEqual([await projectMessages(f.projectId), await messageEvents(conversationId), await f.used(start.id)], [1, 1, 1]);
  assert.equal(toolFailure(await f.tool('flux_start_conversation', { ...opening, message: { body: 'Another text' } })).code, 'IDEMPOTENCY_CONFLICT');

  // A person replies, then the agent replies in the same one-level thread.
  expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'Run it again?', clientMessageId: randomUUID() } }), 201);
  const answer = { ...command(f.projectId, f, reply.id, 'execute'), conversationId, message: { body: 'Running it again now.' } };
  const answered = toolValue(await f.tool('flux_reply_in_conversation', answer));
  assert.deepEqual([answered.conversationId, answered.sequence], [conversationId, 3]);
  conversation = await read(f, conversationId);
  assert.deepEqual(conversation.messages.map((item) => [item.sequence, item.authorId === null ? 'agent' : 'human']), [[1, 'agent'], [2, 'human'], [3, 'agent']]);
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId), await f.used(reply.id)], [3, 3, 1]);
  // Messages are immutable, so a retry after later activity still returns the original outcome, never a second message.
  expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'Thanks', clientMessageId: randomUUID() } }), 201);
  assert.deepEqual(toolValue(await f.tool('flux_reply_in_conversation', answer)), { ...answered, replayed: true });
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId), await f.used(reply.id)], [4, 4, 1]);

  // A task's discussion is a project conversation too: the reply joins its canonical thread.
  const task = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Repeat the measurement' } }), 201);
  const root = expect(await f.owner.request('POST', `/api/v1/work/${task.id}/discussion`, { body: { body: 'Who repeats it?', clientMessageId: randomUUID() } }), 201) as unknown as ConversationMessage;
  const inThread = toolValue(await f.tool('flux_reply_in_conversation', { ...command(f.projectId, f, reply.id, 'execute'),
    conversationId: root.conversationId, message: { body: 'I will, after the baseline.' } }));
  const discussion = expect(await f.owner.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as unknown as TaskDiscussion;
  assert.deepEqual(discussion.messages.map((item) => [item.id, item.authorId === null ? item.author.id : 'human']), [[root.id, 'human'], [inThread.messageId, f.agentId]]);

  // Revocation stops new replies and replays alike: a replay revalidates current authority first.
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}/action-grants/${reply.id}`), 204);
  assert.equal(toolFailure(await f.tool('flux_reply_in_conversation', answer)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await f.tool('flux_reply_in_conversation', { ...answer, clientCommandId: randomUUID() })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual([await messages(conversationId), await f.used(reply.id)], [4, 2]);
});

test('conversation actions never post into a direct message, a private draft, another project or a guessed conversation, and debit nothing', async () => {
  const f = await actionScene(pool);
  const anyConversation = await f.grant('conversation.reply', 'plan', 10);
  const start = await f.grant('conversation.create', 'plan', 10);
  const peerEmail = uniqueEmail('mcp-dm-peer');
  const { browser: peerBrowser } = await register(peerEmail, 'correct horse battery staple', 'DM peer');
  const peer = expect(await peerBrowser.request('GET', '/api/v1/me'), 200).user as { id: string };
  expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`, { body: { email: peerEmail, role: 'member' } }), 201);
  const dm = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/dms`, { body: { participantIds: [peer.id] } }), 201);
  expect(await f.owner.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'Just between us', clientMessageId: randomUUID() } }), 201);
  const draft = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/drafts`, { body: { title: 'Private plan' } }), 201);
  const elsewhere = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Unselected project', visibility: 'restricted' } }), 201);
  const hidden = expect(await f.owner.request('POST', `/api/v1/projects/${elsewhere.id}/conversations`,
    { body: { body: 'Unselected discussion', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const a = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Thread A', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const b = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Thread B', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const post = (grantId: string, conversationId: unknown, message: Record<string, unknown> = { body: 'Agent note' }, peerRequestClass: 'execute' | 'plan' = 'plan') =>
    f.tool('flux_reply_in_conversation', { ...command(f.projectId, f, grantId, peerRequestClass), conversationId, message });
  const dmMessages = async () => (await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id=$1', [dm.id])).rows[0].n as number;

  // A DM, a private draft, another project's conversation and a guessed ID are all just "not a project conversation".
  for (const target of [dm.id, draft.id, hidden.id, randomUUID()]) assert.equal(toolFailure(await post(anyConversation.id, target)).code, 'OBJECT_NOT_FOUND');
  // A private draft is never a citation, and an unselected project is never a destination.
  assert.equal(toolFailure(await post(anyConversation.id, a.id, { body: 'Cites a draft', cite: { materialId: draft.id, version: 1 } })).code, 'MATERIAL_VERSION_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_start_conversation', { ...command(String(elsewhere.id), f, start.id), message: { body: 'Elsewhere' } })).code,
    'PROJECT_NOT_FOUND');

  // A targeted grant authorizes only its conversation; another operation or class authorizes nothing here.
  const onlyA = await f.grant('conversation.reply', 'plan', 10, a.id);
  assert.equal(toolFailure(await post(onlyA.id, b.id)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await post(start.id, a.id)).code, 'AGENT_EXECUTION_UNAVAILABLE', 'a start grant cannot reply');
  assert.equal(toolFailure(await post(anyConversation.id, a.id, { body: 'Wrong class' }, 'execute')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolValue(await post(onlyA.id, a.id)).sequence, 2);

  // An exhausted grant still replays its last success, but makes no new post; an expired one makes none at all.
  const once = await f.grant('conversation.create', 'plan', 1);
  const last = { ...command(f.projectId, f, once.id), message: { body: 'The only start this grant allows' } };
  const made = toolValue(await f.tool('flux_start_conversation', last));
  assert.deepEqual(toolValue(await f.tool('flux_start_conversation', last)), { ...made, replayed: true });
  assert.equal(toolFailure(await f.tool('flux_start_conversation', { ...last, clientCommandId: randomUUID() })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  await pool.query("UPDATE agent_standing_grants SET expires_at = now() - interval '1 second' WHERE id=$1", [anyConversation.id]);
  assert.equal(toolFailure(await post(anyConversation.id, b.id)).code, 'AGENT_EXECUTION_UNAVAILABLE');

  assert.deepEqual([await f.used(anyConversation.id), await f.used(start.id), await f.used(onlyA.id), await f.used(once.id)], [0, 0, 1, 1]);
  assert.deepEqual([await dmMessages(), await messages(a.id), await messages(b.id), await messages(hidden.id)], [1, 2, 1, 1]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE author_agent_id=$1', [f.agentId])).rows[0].n, 2);
});

test('two owners and three connections stay isolated: grants, receipts, targets and revocation never cross', async () => {
  // Hubert's two connections (one agent each) share his project; Marek's third connection has his own.
  const hubert = await actionScene(pool);
  const second = expect(await hubert.owner.request('POST', `/api/v1/workspaces/${hubert.workspaceId}/agents`, { body: { name: 'Review agent', owner: 'self' } }), 201);
  expect(await hubert.owner.request('POST', `/api/v1/projects/${hubert.projectId}/grants`,
    { body: { principal: { kind: 'agent', id: second.id }, role: 'contributor' } }), 201);
  const review = await agentConnection(pool, hubert.owner, String(second.id), [hubert.projectId]);
  const { browser: marek } = await register(uniqueEmail('mcp-marek'), 'correct horse battery staple', 'Marek');
  const space = expect(await marek.request('POST', '/api/v1/workspaces', { body: { name: 'Marek space' } }), 201);
  const own = expect(await marek.request('POST', `/api/v1/workspaces/${space.id}/projects`, { body: { name: 'Marek project', visibility: 'restricted' } }), 201);
  const third = expect(await marek.request('POST', `/api/v1/workspaces/${space.id}/agents`, { body: { name: 'Marek agent', owner: 'self' } }), 201);
  expect(await marek.request('POST', `/api/v1/projects/${own.id}/grants`, { body: { principal: { kind: 'agent', id: third.id }, role: 'contributor' } }), 201);
  const marekAgent = await agentConnection(pool, marek, String(third.id), [String(own.id)]);
  assert.deepEqual(new Set([hubert.runtimeSessionId, review.runtimeSessionId, marekAgent.runtimeSessionId]).size, 3, 'three distinct runtimes');

  const planning = await hubert.grant('conversation.create', 'plan');
  const reviewing = await review.grant('conversation.create', 'plan');
  const shared = randomUUID();
  // The same command ID on two connections is two independent commands, each by its own agent.
  const one = toolValue(await hubert.tool('flux_start_conversation', { ...command(hubert.projectId, hubert, planning.id, 'plan', shared), message: { body: 'From the planning agent' } }));
  const two = toolValue(await review.tool('flux_start_conversation', { ...command(hubert.projectId, review, reviewing.id, 'plan', shared), message: { body: 'From the review agent' } }));
  assert.notEqual(one.conversationId, two.conversationId);
  assert.deepEqual([(await read(hubert, String(one.conversationId))).messages[0]!.author?.id, (await read(hubert, String(two.conversationId))).messages[0]!.author?.id],
    [hubert.agentId, String(second.id)]);
  assert.deepEqual(toolValue(await hubert.tool('flux_start_conversation', { ...command(hubert.projectId, hubert, planning.id, 'plan', shared),
    message: { body: 'From the planning agent' } })), { ...one, replayed: true }, 'a replay returns only its own connection\'s receipt');
  // Two connections of one agent (two of Hubert's clients) are two runtimes too: the same command ID and text
  // make a second message by that agent, never a replay of the other connection's receipt.
  const twin = await agentConnection(pool, hubert.owner, hubert.agentId, [hubert.projectId]);
  const twinStart = await twin.grant('conversation.create', 'plan');
  const three = toolValue(await twin.tool('flux_start_conversation', { ...command(hubert.projectId, twin, twinStart.id, 'plan', shared), message: { body: 'From the planning agent' } }));
  assert.equal(three.replayed, false);
  assert.notEqual(three.conversationId, one.conversationId);
  assert.notEqual(three.messageId, one.messageId);
  assert.equal((await read(hubert, String(three.conversationId))).messages[0]!.author?.id, hubert.agentId);

  // A grant belongs to exactly one connection: neither Hubert's other connection nor Marek's can use it.
  const doc = await hubert.grant('doc.create', 'plan');
  assert.equal(toolFailure(await review.tool('flux_start_conversation', { ...command(hubert.projectId, review, planning.id), message: { body: 'Borrowed grant' } })).code,
    'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await review.tool('flux_create_doc', { ...command(hubert.projectId, review, doc.id), doc: { title: 'Borrowed grant' } })).code,
    'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await marekAgent.tool('flux_start_conversation', { ...command(hubert.projectId, marekAgent, planning.id), message: { body: 'Foreign' } })).code,
    'PROJECT_NOT_FOUND', 'another owner\'s project is outside the selection');
  const marekReply = await marekAgent.grant('conversation.reply', 'plan');
  const marekDoc = await marekAgent.grant('doc.update', 'plan');
  const hubertDoc = expect(await hubert.owner.request('POST', `/api/v1/projects/${hubert.projectId}/docs`, { body: { title: 'Hubert notes' } }), 201) as unknown as Doc;
  assert.equal(toolFailure(await marekAgent.tool('flux_reply_in_conversation', { ...command(String(own.id), marekAgent, marekReply.id),
    conversationId: one.conversationId, message: { body: 'Foreign reply' } })).code, 'OBJECT_NOT_FOUND');
  assert.equal(toolFailure(await marekAgent.tool('flux_update_doc', { ...command(String(own.id), marekAgent, marekDoc.id),
    docId: hubertDoc.id, expectedVersion: 1, changes: { body: 'Foreign edit' } })).code, 'OBJECT_NOT_FOUND');

  // Revoking one connection affects only that connection.
  expect(await hubert.owner.request('DELETE', `/api/v1/agent-connections/${hubert.connectionId}`), 204);
  assert.equal((await hubert.raw('flux_start_conversation', { ...command(hubert.projectId, hubert, planning.id), message: { body: 'After revocation' } })).status, 403);
  const reply = await review.grant('conversation.reply', 'execute');
  assert.equal(toolValue(await review.tool('flux_reply_in_conversation', { ...command(hubert.projectId, review, reply.id, 'execute'),
    conversationId: one.conversationId, message: { body: 'Still connected' } })).sequence, 2);

  assert.deepEqual([await hubert.used(planning.id), await hubert.used(reviewing.id), await hubert.used(doc.id), await hubert.used(marekReply.id), await hubert.used(marekDoc.id)],
    [1, 1, 0, 0, 0]);
  // Three starts (planning, review and the twin connection) and one reply; nothing in Marek's project.
  assert.deepEqual([await projectMessages(hubert.projectId), await projectMessages(String(own.id))], [4, 0]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id=$1', [hubertDoc.id])).rows[0].n, 1);
});

test('the person-facing conversation commands still refuse an agent principal; only the standing-grant composition opts in', async () => {
  const f = await actionScene(pool);
  const people = conversationUseCases(conversationStore(db));
  const agent = { kind: 'agent', id: f.agentId } as const;
  const opened = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`,
    { body: { body: 'People write here', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const personOnly = (error: unknown) => error instanceof InvalidInputError && error.message === 'A signed-in person is required';
  await assert.rejects(people.createConversation(agent, f.projectId, { body: 'Agent start', clientMessageId: randomUUID() }), personOnly);
  await assert.rejects(people.sendMessage(agent, opened.id, { body: 'Agent reply', clientMessageId: randomUUID() }), personOnly);
  assert.deepEqual([await messages(opened.id), await projectMessages(f.projectId)], [1, 1], 'nothing was written');
});
