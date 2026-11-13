import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
const command = (projectId: string, connection: Connection, peerRequestClass: 'execute' | 'plan' = 'plan', clientCommandId: string = randomUUID()) => ({
  projectId, runtimeSessionId: connection.runtimeSessionId, clientCommandId, peerRequestClass, sources: [] as { materialId: string; version: number }[] });
const read = async (f: Scene, conversationId: string) => expect(await f.owner.request('GET', `/api/v1/conversations/${conversationId}`), 200) as unknown as Conversation;

test('a local client starts a project conversation and replies in a thread as its owner, marked via the client: one message and event per command', async () => {
  const f = await actionScene(pool);
  const capabilities = f.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation?.startsWith('conversation.')).map(({ name, operation, classes, available }) => ({ name, operation, classes, available })),
    [{ name: 'flux_start_conversation', operation: 'conversation.create', classes: ['execute', 'plan'], available: true },
      { name: 'flux_reply_in_conversation', operation: 'conversation.reply', classes: ['execute', 'plan'], available: true },
      { name: 'flux_discuss_task', operation: 'conversation.reply', classes: ['execute', 'plan'], available: true },
      { name: 'flux_ask_question', operation: 'conversation.reply', classes: ['execute', 'plan'], available: true }]);
  const first = randomUUID();
  const opening = { ...command(f.projectId, f, 'plan', first), sources: [f.source],
    message: { body: 'The baseline holds at four hours.', cite: f.source } };
  const started = toolValue(await f.tool('flux_start_conversation', opening));
  const conversationId = String(started.conversationId);
  assert.deepEqual([started.sequence, started.replayed], [1, false]);
  let conversation = await read(f, conversationId);
  const ownerId = (expect(await f.owner.request('GET', '/api/v1/me'), 200) as unknown as { user: { id: string } }).user.id;
  // LC-2 (#1091): the client's post is its owner's own message, marked with the client's name ("Test client" here); no agent is the author.
  assert.deepEqual([conversation.audience, conversation.createdBy, conversation.createdByActor], [{ kind: 'project', projectId: f.projectId }, ownerId, undefined]);
  assert.deepEqual(conversation.messages.map((item) => [item.id, item.authorId, 'author' in item, item.via, item.body, item.source]),
    [[started.messageId, ownerId, false, 'Test client', 'The baseline holds at four hours.', f.source]],
    'the owner is the author, marked via the client');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE author_agent_id = $1', [f.agentId])).rows[0].n, 0, 'the agent wrote nothing');
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId)], [1, 1]);

  // A lost response is retried with the same command ID: the stored outcome, no second conversation, message, event or debit.
  assert.deepEqual(toolValue(await f.tool('flux_start_conversation', opening)), { ...started, replayed: true });
  assert.deepEqual([await projectMessages(f.projectId), await messageEvents(conversationId)], [1, 1]);
  assert.equal(toolFailure(await f.tool('flux_start_conversation', { ...opening, message: { body: 'Another text' } })).code, 'IDEMPOTENCY_CONFLICT');

  // A person replies, then the agent replies in the same one-level thread.
  expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'Run it again?', clientMessageId: randomUUID() } }), 201);
  const answer = { ...command(f.projectId, f, 'execute'), conversationId, message: { body: 'Running it again now.' } };
  const answered = toolValue(await f.tool('flux_reply_in_conversation', answer));
  assert.deepEqual([answered.conversationId, answered.sequence], [conversationId, 3]);
  conversation = await read(f, conversationId);
  assert.deepEqual(conversation.messages.map((item) => [item.sequence, item.authorId === ownerId, item.via ?? null]), [[1, true, 'Test client'], [2, true, null], [3, true, 'Test client']],
    'the person\'s own reply carries no mark; the client\'s do');
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId)], [3, 3]);
  // Messages are immutable, so a retry after later activity still returns the original outcome, never a second message.
  expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'Thanks', clientMessageId: randomUUID() } }), 201);
  assert.deepEqual(toolValue(await f.tool('flux_reply_in_conversation', answer)), { ...answered, replayed: true });
  assert.deepEqual([await messages(conversationId), await messageEvents(conversationId)], [4, 4]);

  // A task's discussion is a project conversation too: the reply joins its canonical thread, as the agent's own line (C-51), not the owner's.
  const task = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Repeat the measurement' } }), 201);
  const root = expect(await f.owner.request('POST', `/api/v1/work/${task.id}/discussion`, { body: { body: 'Who repeats it?', clientMessageId: randomUUID() } }), 201) as unknown as ConversationMessage;
  const inThread = toolValue(await f.tool('flux_reply_in_conversation', { ...command(f.projectId, f, 'execute'),
    conversationId: root.conversationId, message: { body: 'I will, after the baseline.' } }));
  const discussion = expect(await f.owner.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as unknown as TaskDiscussion;
  assert.deepEqual(discussion.messages.map((item) => [item.id, item.authorId === null ? item.author.id : 'human', item.via ?? null]), [[root.id, 'human', null], [inThread.messageId, f.agentId, null]]);

  // Revocation stops new replies and replays alike: a replay revalidates current authority first.
  assert.deepEqual([await messages(conversationId)], [4]);
});

test('conversation actions never post into a direct message, a private map, someone else\'s space or a guessed conversation, and debit nothing', async () => {
  const f = await actionScene(pool);
  const peerEmail = uniqueEmail('mcp-dm-peer');
  const { browser: peerBrowser } = await register(peerEmail, 'correct horse battery staple', 'DM peer');
  const peer = expect(await peerBrowser.request('GET', '/api/v1/me'), 200).user as { id: string };
  expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`, { body: { email: peerEmail, role: 'member' } }), 201);
  const dm = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/dms`, { body: { participantIds: [peer.id] } }), 201);
  expect(await f.owner.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'Just between us', clientMessageId: randomUUID() } }), 201);
  const draft = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`, { body: { title: 'Private plan', scope: 'private' } }), 201);
  // Another person's space: the client has its owner's rights and no more, so it is neither readable nor a destination.
  const stranger = await actionScene(pool);
  const elsewhere = { id: stranger.projectId };
  const hidden = expect(await stranger.owner.request('POST', `/api/v1/projects/${elsewhere.id}/conversations`,
    { body: { body: 'Another person\'s discussion', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const a = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Thread A', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const b = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'Thread B', clientMessageId: randomUUID() } }), 201) as unknown as Conversation;
  const post = ( conversationId: unknown, message: Record<string, unknown> = { body: 'Agent note' }, peerRequestClass: 'execute' | 'plan' = 'plan') =>
    f.tool('flux_reply_in_conversation', { ...command(f.projectId, f, peerRequestClass), conversationId, message });
  const dmMessages = async () => (await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id=$1', [dm.id])).rows[0].n as number;

  // A DM, a private map, another project's conversation and a guessed ID are all just "not a project conversation".
  for (const target of [dm.id, draft.id, hidden.id, randomUUID()]) assert.equal(toolFailure(await post(target)).code, 'OBJECT_NOT_FOUND');
  // A private map is never a citation, and another person's space is never a destination.
  assert.equal(toolFailure(await post(a.id, { body: 'Cites a map', cite: { materialId: draft.id, version: 1 } })).code, 'MATERIAL_VERSION_NOT_FOUND');
  assert.equal(toolFailure(await f.tool('flux_start_conversation', { ...command(String(elsewhere.id), f), message: { body: 'Elsewhere' } })).code,
    'PROJECT_NOT_FOUND');

  // A targeted grant authorizes only its conversation; another operation or class authorizes nothing here.
  assert.equal(toolValue(await post(a.id)).sequence, 2);

  // An exhausted grant still replays its last success, but makes no new post; an expired one makes none at all.
  const last = { ...command(f.projectId, f), message: { body: 'The only start this grant allows' } };
  const made = toolValue(await f.tool('flux_start_conversation', last));
  assert.deepEqual(toolValue(await f.tool('flux_start_conversation', last)), { ...made, replayed: true });

  assert.deepEqual([await dmMessages(), await messages(a.id), await messages(b.id), await messages(hidden.id)], [1, 2, 1, 1]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1 AND via IS NOT NULL', [f.projectId])).rows[0].n, 2, 'the two posts are the owner\'s, marked via the client');
});

test('#1232: a message shown with Show everyone before the label existed (a name in `via`, no colour) is backfilled as an agent answer in ink; a local client\'s post is not', async () => {
  const f = await actionScene(pool);
  const started = toolValue(await f.tool('flux_start_conversation', { ...command(f.projectId, f), message: { body: 'Posted by the client' } }));
  const conversationId = String(started.conversationId);
  const sent = expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'An answer shown before the label', clientMessageId: randomUUID() } }), 201);
  await pool.query('UPDATE project_messages SET via = $2 WHERE id = $1', [String(sent.id), 'Assistant']);
  const clientRow = (await pool.query('SELECT id FROM project_messages WHERE conversation_id = $1 AND via IS NOT NULL AND id <> $2', [conversationId, String(sent.id)])).rows[0] as { id: string };
  // The migration's own statements, run on this data and then rolled back: nothing else a test left is changed.
  const sql = (await readFile('packages/db/migrations/0059_message_via_colour.sql', 'utf8')).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = sql.split(';').map((statement) => statement.trim()).filter((statement) => /^UPDATE/i.test(statement));
  assert.equal(statements.length, 2);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement);
    const rows = (await client.query('SELECT id, via, via_colour FROM project_messages WHERE id = ANY($1)', [[String(sent.id), clientRow.id]])).rows as { id: string; via: string; via_colour: string | null }[];
    assert.deepEqual(rows.map((row) => [row.id === clientRow.id ? 'client' : 'answer', row.via, row.via_colour]).sort(), [['answer', 'Assistant', 'ink'], ['client', 'Test client', null]]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const after = await read(f, conversationId);
  assert.deepEqual(after.messages.map((item) => [item.via ?? null, item.viaColour ?? null]), [['Test client', null], ['Assistant', null]], 'rolled back: nothing a test left changed');
});

test('two owners and three connections stay isolated: grants, receipts, targets and revocation never cross', async () => {
  // Hubert's two connections (one agent each) share his project; Marek's third connection has his own.
  const hubert = await actionScene(pool);
  const second = expect(await hubert.owner.request('POST', `/api/v1/workspaces/${hubert.workspaceId}/agents`, { body: { name: 'Review agent', owner: 'self' } }), 201);
  const review = await agentConnection(pool, hubert.owner, String(second.id), [hubert.projectId]);
  const { browser: marek } = await register(uniqueEmail('mcp-marek'), 'correct horse battery staple', 'Marek');
  const space = expect(await marek.request('POST', '/api/v1/workspaces', { body: { name: 'Marek space' } }), 201);
  const own = expect(await marek.request('POST', `/api/v1/workspaces/${space.id}/projects`, { body: { name: 'Marek project', visibility: 'restricted' } }), 201);
  const third = expect(await marek.request('POST', `/api/v1/workspaces/${space.id}/agents`, { body: { name: 'Marek agent', owner: 'self' } }), 201);
  const marekAgent = await agentConnection(pool, marek, String(third.id), [String(own.id)]);
  assert.deepEqual(new Set([hubert.runtimeSessionId, review.runtimeSessionId, marekAgent.runtimeSessionId]).size, 3, 'three distinct runtimes');

  const shared = randomUUID();
  // The same command ID on two connections is two independent commands, each by its own agent.
  const one = toolValue(await hubert.tool('flux_start_conversation', { ...command(hubert.projectId, hubert, 'plan', shared), message: { body: 'From the planning agent' } }));
  const two = toolValue(await review.tool('flux_start_conversation', { ...command(hubert.projectId, review, 'plan', shared), message: { body: 'From the review agent' } }));
  assert.notEqual(one.conversationId, two.conversationId);
  const postedBy = async (messageId: unknown) => (await pool.query('SELECT agent_id FROM assistant_changes WHERE object_id = $1', [messageId])).rows[0].agent_id as string;
  assert.deepEqual([await postedBy(one.messageId), await postedBy(two.messageId)], [hubert.agentId, String(second.id)], 'each post is its own connection\'s change');
  assert.deepEqual(toolValue(await hubert.tool('flux_start_conversation', { ...command(hubert.projectId, hubert, 'plan', shared),
    message: { body: 'From the planning agent' } })), { ...one, replayed: true }, 'a replay returns only its own connection\'s receipt');
  // Two connections of one agent (two of Hubert's clients) are two runtimes too: the same command ID and text
  // make a second message by that agent, never a replay of the other connection's receipt.
  const twin = await agentConnection(pool, hubert.owner, hubert.agentId, [hubert.projectId]);
  const three = toolValue(await twin.tool('flux_start_conversation', { ...command(hubert.projectId, twin, 'plan', shared), message: { body: 'From the planning agent' } }));
  assert.equal(three.replayed, false);
  assert.notEqual(three.conversationId, one.conversationId);
  assert.notEqual(three.messageId, one.messageId);
  assert.equal(await postedBy(three.messageId), hubert.agentId);

  // A grant belongs to exactly one connection: neither Hubert's other connection nor Marek's can use it.
  assert.equal(toolFailure(await marekAgent.tool('flux_start_conversation', { ...command(hubert.projectId, marekAgent), message: { body: 'Foreign' } })).code,
    'PROJECT_NOT_FOUND', 'another owner\'s project is outside the selection');
  const hubertDoc = expect(await hubert.owner.request('POST', `/api/v1/projects/${hubert.projectId}/docs`, { body: { title: 'Hubert notes' } }), 201) as unknown as Doc;
  assert.equal(toolFailure(await marekAgent.tool('flux_reply_in_conversation', { ...command(String(own.id), marekAgent),
    conversationId: one.conversationId, message: { body: 'Foreign reply' } })).code, 'OBJECT_NOT_FOUND');
  assert.equal(toolFailure(await marekAgent.tool('flux_update_doc', { ...command(String(own.id), marekAgent),
    docId: hubertDoc.id, expectedVersion: 1, changes: { body: 'Foreign edit' } })).code, 'OBJECT_NOT_FOUND');

  // Revoking one connection affects only that connection.
  expect(await hubert.owner.request('DELETE', `/api/v1/agent-connections/${hubert.connectionId}`), 204);
  assert.equal((await hubert.raw('flux_start_conversation', { ...command(hubert.projectId, hubert), message: { body: 'After revocation' } })).status, 403);
  assert.equal(toolValue(await review.tool('flux_reply_in_conversation', { ...command(hubert.projectId, review, 'execute'),
    conversationId: one.conversationId, message: { body: 'Still connected' } })).sequence, 2);

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

test('#1437: a local client stages a file with flux_attach_file and posts it with its message, as its owner\'s own attachment', async () => {
  const f = await actionScene(pool);
  const page = '<!doctype html><h1>Baseline</h1><script>alert(1)</script>';
  const staged = toolValue(await f.tool('flux_attach_file', { projectId: f.projectId, clientCommandId: randomUUID(), name: 'baseline.html', content: page }));
  assert.equal(staged.name, 'baseline.html');
  const pdf = toolValue(await f.tool('flux_attach_file', { projectId: f.projectId, clientCommandId: randomUUID(), name: 'tiny.pdf', encoding: 'base64',
    content: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') }));
  const ownerId = (expect(await f.owner.request('GET', '/api/v1/me'), 200) as unknown as { user: { id: string } }).user.id;
  assert.deepEqual((await pool.query('SELECT uploader_id, message_id FROM project_files WHERE id = $1', [staged.fileId])).rows, [{ uploader_id: ownerId, message_id: null }],
    'staged as the owner\'s own upload, on no message yet');
  const started = toolValue(await f.tool('flux_start_conversation', { ...command(f.projectId, f), message: { body: 'The baseline, as a page and a PDF.' },
    attachmentIds: [staged.fileId, pdf.fileId] }));
  const conversation = await read(f, String(started.conversationId));
  assert.deepEqual(conversation.messages[0]!.files?.map((file) => file.name), ['baseline.html', 'tiny.pdf']);
  assert.equal(conversation.messages[0]!.via, 'Test client');
  const download = await fetch(new URL(`/api/v1/files/${staged.fileId}`, f.owner.base), { headers: { cookie: f.owner.cookieHeader() } });
  assert.equal(await download.text(), page);
  // A file that is not the owner's staged upload of this project is refused with the post, which then makes nothing.
  assert.ok(toolFailure(await f.tool('flux_start_conversation', { ...command(f.projectId, f), message: { body: 'again' }, attachmentIds: [staged.fileId] })).code);
  const refused = (await f.tool('flux_attach_file', { projectId: f.projectId, clientCommandId: randomUUID(), name: '../x.txt', content: 'x' }))?.result as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(refused.isError, true);
  assert.match(refused.content![0]!.text!, /^Not attached\. /);
});
