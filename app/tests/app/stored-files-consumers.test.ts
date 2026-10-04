import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createPersonalRunProcessor, type Principal } from '@flux/core';
import {
  PERSONAL_RUN_CONSENT_VERSION,
  type Conversation, type ConversationMessage, type ConversationSummary, type InboxItem, type InboxResponse, type Project,
  type ReturnSummary, type SearchResponse, type SearchResult, type StagedFile, type Workspace,
} from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { toolValue } from './support/mcp.js';
import { agentConnection } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';

// A file-only message (empty body plus attachments, #154) reads as its attachments, never as empty
// text and never as the file's bytes, in every projection that quotes a message: notifications,
// search, the return digest, the MCP conversation read and a personal run's source text.

const SECRET = `SECRETBYTES${randomUUID().replace(/-/g, '')}`;
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const text = (value: SearchResult['title']) => value.map((part) => part.text).join('');

async function upload(who: Person, projectId: string, bytes: Uint8Array, name: string) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin },
    body: Buffer.from(bytes),
  });
  assert.equal(response.status, 201, `upload ${name}`);
  return (await response.json()) as StagedFile;
}
async function inboxItem(someone: Person, messageId: string, what: string) {
  return waitFor(async () => (expectStatus(await someone.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse).items
    .find((item: InboxItem) => item.url?.endsWith(`#message-${messageId}`)), what);
}
async function agent(owner: Person, workspaceId: string, projectId: string, name: string) {
  const created = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: created.id }, role: 'contributor' } }), 201, 'agent grant');
  return created.id;
}

describe('a file-only message in every consumer that quotes it', () => {
  let owner: Person; let writer: Person;
  let ws: Workspace; let place: Project;
  let talk: Conversation; let reply: ConversationMessage; let file: StagedFile;
  let opened: Conversation; let answer: ConversationMessage;

  before(async () => {
    owner = await person('Consumer owner');
    writer = await person('Consumer writer');
    ws = await workspace(owner, 'File consumers');
    await addMember(owner, ws.id, writer, 'member');
    place = await project(owner, ws.id, 'Sensor files', 'restricted');
    await grant(owner, place.id, writer, 'contributor');
    talk = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Which sensor works in low light?', clientMessageId: randomUUID() } }), 201) as Conversation;
    file = await upload(writer, place.id, Buffer.from(`${SECRET} lux readings`), 'findings.txt');
    reply = expectStatus(await writer.browser.request('POST', `/api/v1/conversations/${talk.id}/messages`,
      { body: { body: '', attachmentIds: [file.id], clientMessageId: randomUUID() } }), 201) as ConversationMessage;
    assert.deepEqual([reply.body, reply.files], ['', [{ id: file.id, name: 'findings.txt', size: file.size }]]);
    const notes = await upload(writer, place.id, Buffer.from(`${SECRET} wiring notes`), 'notes.txt');
    opened = expectStatus(await writer.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: '', attachmentIds: [notes.id], clientMessageId: randomUUID() } }), 201) as Conversation;
    answer = expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${opened.id}/messages`,
      { body: { body: 'Thanks, reading it now', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  });

  test('notifications describe a file-only reply and a file-only opening by their attachments', async () => {
    const replied = await inboxItem(owner, reply.id, 'the owner\'s reply notification');
    assert.deepEqual([replied.reason, replied.title, replied.body],
      ['reply', 'Consumer writer replied in “Which sensor works in low light?”', '1 attached file']);
    const answered = await inboxItem(writer, answer.id, 'the writer\'s reply notification');
    assert.deepEqual([answered.reason, answered.title, answered.body],
      ['reply', 'Consumer owner replied in “1 attached file”', 'Thanks, reading it now']);
    for (const someone of [owner, writer])
      assert.equal((await someone.browser.request('GET', '/api/v1/inbox')).text.includes(SECRET), false, 'no file bytes in the inbox');
  });

  test('search titles a file-only message "Attached files" and never indexes file bytes', async () => {
    const found = expectStatus(await owner.browser.request('GET', '/api/v1/search?q=attached'), 200) as SearchResponse;
    for (const messageId of [reply.id, opened.messages[0]!.id]) {
      const item = found.items.find((entry) => entry.id === `message:${messageId}`);
      assert.ok(item, `search finds file-only message ${messageId}`);
      assert.equal(text(item.title), 'Attached files');
    }
    const { rows } = await pool.query('SELECT title, body FROM search_documents WHERE doc_key = $1', [`message:${reply.id}`]);
    assert.deepEqual(rows.map((row: { title: string; body: string }) => [row.title, row.body]), [['Attached files', '']]);
    const bytes = expectStatus(await owner.browser.request('GET', `/api/v1/search?q=${SECRET}`), 200) as SearchResponse;
    assert.deepEqual(bytes.items, []);
  });

  test('the return list and digest quote a file-only message and opening as "1 attached file"', async () => {
    const recap = expectStatus(await owner.browser.request('GET', `/api/v1/return?place=project&id=${place.id}&digest=1`), 200) as ReturnSummary;
    const digest = recap.digest!;
    const replyTalk = digest.conversations.find((entry) => entry.conversationId === talk.id);
    assert.ok(replyTalk, 'the digest covers the conversation with the file-only reply');
    assert.equal(replyTalk.quotes.find((quote) => quote.messageId === reply.id)?.excerpt, '1 attached file');
    const openedTalk = digest.conversations.find((entry) => entry.conversationId === opened.id);
    assert.ok(openedTalk, 'the digest covers the file-only opening');
    assert.equal(openedTalk.opening, '1 attached file');
    assert.equal(openedTalk.quotes.find((quote) => quote.messageId === opened.messages[0]!.id)?.excerpt, '1 attached file');
    // The "since you left" line for that conversation shows the file-only reply as its detail too.
    assert.equal(recap.items.find((item) => item.id === `conversation:${talk.id}`)?.detail, '1 attached file');
    assert.equal(JSON.stringify(recap).includes(SECRET), false);
  });

  test('an MCP read lists the message files and the conversation list previews them', async () => {
    const agentId = await agent(owner, ws.id, place.id, 'File reader agent');
    const { tool } = await agentConnection(pool, owner.browser, agentId, [place.id]);
    const read = toolValue(await tool('flux_get_conversation', { projectId: place.id, id: talk.id })) as unknown as Conversation;
    const message = read.messages.find((entry) => entry.id === reply.id);
    assert.ok(message, 'the MCP read includes the file-only reply');
    assert.equal(message.body, '');
    assert.deepEqual(message.files, [{ id: file.id, name: 'findings.txt', size: file.size }]);
    const listed = toolValue(await tool('flux_list_conversations', { projectId: place.id, limit: 50 })) as unknown as { items: ConversationSummary[] };
    assert.equal(listed.items.find((entry) => entry.id === talk.id)?.lastMessageBody, '1 attached file');
    assert.equal(listed.items.find((entry) => entry.id === opened.id)?.firstMessageBody, '1 attached file');
    assert.equal(JSON.stringify([read, listed]).includes(SECRET), false);
  });

  test('a personal run names the attached files without their contents', async () => {
    const connections = new FakeConnections();
    const compute = new FakeCompute();
    const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections, providerEnabled: true });
    const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
    const agentId = await agent(owner, ws.id, place.id, 'Owner assistant');
    connections.connect(owner.id, randomUUID());
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, dailyCapCents: 1000 });
    const { run } = await runs.invoke(human(owner), talk.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What did the writer send?' });
    assert.equal(await processor.process(run.id), 'completed');
    assert.equal(compute.dispatched.length, 1);
    const input = compute.dispatched[0]!.input;
    assert.ok(input.includes(`Attached files (contents not included): findings.txt (${file.size} bytes; file ${file.id})`), input);
    assert.equal(input.includes(SECRET), false, 'the file bytes never reach the provider input');
  });
});
