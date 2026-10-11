import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TaskAgentThread, ConversationMessage, WorkItem, Page, ConversationSummary, UndoTaskCreationResult } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { pool } from './support/db.js';

async function scene() {
  const [owner, writer, viewer, outsider] = await Promise.all(['thread-owner', 'thread-writer', 'thread-viewer', 'thread-outsider'].map(person));
  const ws = await workspace(owner, 'Work conversations');
  for (const p of [writer, viewer, outsider]) await addMember(owner, ws.id, p, 'member');
  const place = await project(owner, ws.id, 'Agent planning', 'restricted');
  await grant(owner, place.id, writer, 'contributor'); await grant(owner, place.id, viewer, 'viewer');
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title: 'Compare the prototype measurements', clientCommandId: randomUUID() },
  }), 201) as WorkItem;
  const path = `/api/v1/work/${task.id}/agent-thread`;
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE work_id=$1', [task.id])).rows[0].n;
  return { owner, writer, viewer, outsider, ws, place, task, path, count };
}

test('read/open creates nothing; concurrent first posts have one thread, exact audience and retry identity', async () => {
  const f = await scene();
  for (const p of [f.owner, f.viewer]) {
    const read = expectStatus(await p.browser.request('GET', f.path), 200) as TaskAgentThread;
    assert.equal(read.conversation, null); assert.equal(read.messageCount, 0);
    assert.equal(read.canWrite, p.id === f.owner.id);
  }
  assert.equal(await f.count(), 0);
  const a = { body: 'The current measurements need one comparison.', clientMessageId: randomUUID() };
  const b = { body: 'I can add the second reading.', clientMessageId: randomUUID() };
  const [first, second, duplicate] = await Promise.all([
    f.owner.browser.request('POST', f.path, { body: a }), f.writer.browser.request('POST', f.path, { body: b }),
    f.owner.browser.request('POST', f.path, { body: a }),
  ]);
  const ma = expectStatus(first, 201) as ConversationMessage, mb = expectStatus(second, 201) as ConversationMessage;
  assert.deepEqual(expectStatus(duplicate, 201), ma);
  assert.equal(ma.conversationId, mb.conversationId); assert.equal(ma.authorId, f.owner.id); assert.equal(mb.authorId, f.writer.id);
  assert.equal(await f.count(), 1);
  const read = expectStatus(await f.viewer.browser.request('GET', f.path), 200) as TaskAgentThread;
  assert.equal(read.messageCount, 2); assert.equal(read.conversation?.audience.projectId, f.place.id);
  assert.deepEqual(read.conversation?.messages.map(m => m.sequence), [1, 2]);
  assert.equal((await f.owner.browser.request('POST', f.path, { body: { ...a, body: 'A changed intent' } })).status, 409);
  const foreign = await project(f.owner, f.ws.id, 'Another place', 'restricted');
  assert.equal((await f.owner.browser.request('POST', f.path, { body: { ...a, projectId: foreign.id } })).status, 400);
  assert.equal(await f.count(), 1);
  const row = (await pool.query('SELECT workspace_id,project_id,work_id,space FROM project_conversations WHERE id=$1', [ma.conversationId])).rows[0];
  assert.deepEqual(row, { workspace_id: f.ws.id, project_id: f.place.id, work_id: f.task.id, space: 'agents' });
  assert.ok((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.task.id])).rows[0].first_persisted_use_at);
});

test('viewer and non-reader refusals precede metadata/effects, and revocation applies to the next call', async () => {
  const f = await scene(); const body = { body: 'A real step', clientMessageId: randomUUID() };
  expectStatus(await f.owner.browser.request('POST', f.path, { body }), 201);
  assert.equal((await f.viewer.browser.request('POST', f.path, { body: { ...body, clientMessageId: randomUUID() } })).status, 403);
  const hidden = await f.outsider.browser.request('GET', f.path);
  const absent = await f.outsider.browser.request('GET', `/api/v1/work/${randomUUID()}/agent-thread`);
  assert.equal(hidden.status, 404); assert.deepEqual(hidden.json, absent.json);
  assert.equal((await f.outsider.browser.request('POST', f.path, { body })).status, 404);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  assert.equal((await f.writer.browser.request('GET', f.path)).status, 404);
  assert.equal((await f.writer.browser.request('POST', f.path, { body })).status, 404);
  assert.equal((expectStatus(await f.owner.browser.request('GET', f.path), 200) as TaskAgentThread).messageCount, 1);
  assert.equal((await f.owner.browser.request('GET', f.path + '?limit=51')).status, 400);
});

test('agent-thread posts are absent from people roots/lists, including generic human replies', async () => {
  const f = await scene();
  const posted = expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: 'A quiet progress line', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  expectStatus(await f.writer.browser.request('POST', `/api/v1/conversations/${posted.conversationId}/messages`, {
    body: { body: 'Another quiet line', clientMessageId: randomUUID() },
  }), 201);
  const list = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.place.id}/conversations`), 200) as Page<ConversationSummary>;
  assert.equal(list.total, 0); assert.deepEqual(list.items, []);
  const roots = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.place.id}/conversation-roots`), 200) as { roots: unknown[] };
  assert.deepEqual(roots.roots, []);
  const events = await pool.query("SELECT kind FROM events WHERE object_id=$1 AND kind LIKE 'project.%message%'", [f.place.id]);
  assert.deepEqual(events.rows.map(r => r.kind), ['project.agent_thread_message_sent.v1', 'project.agent_thread_message_sent.v1']);
});

test('all new-space agent replies fail closed while an actual OAuth v1 people reply remains valid', async () => {
  const f = await actionScene(pool); const replyGrant = await f.grant('conversation.reply', 'execute');
  const task = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Thread guard trial' } }), 201) as unknown as WorkItem;
  const posted = expect(await f.owner.request('POST', `/api/v1/work/${task.id}/agent-thread`, { body: { body: 'The human starts the thread.', clientMessageId: randomUUID() } }), 201) as unknown as ConversationMessage;
  const envelope = { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: replyGrant.id,
    clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [] };
  const blocked = toolFailure(await f.tool('flux_reply_in_conversation', { ...envelope, conversationId: posted.conversationId, message: { body: 'An unguarded agent turn' } }));
  assert.equal(blocked.code, 'AGENT_EXECUTION_UNAVAILABLE'); assert.equal(await f.used(replyGrant.id), 0);
  await assert.rejects(() => pool.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_agent_id,client_message_id,request_fingerprint,sequence,body)
    VALUES($1,$2,$3,$4,$5,$6,$7,2,'Bypass attempt')`, [randomUUID(), f.workspaceId, f.projectId, posted.conversationId, f.agentId, randomUUID(), 'x']),
    (e: unknown) => !!e && typeof e === 'object' && 'constraint' in e && e.constraint === 'agent_thread_agent_writes_closed');
  const people = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'People conversation', clientMessageId: randomUUID() } }), 201);
  const allowed = toolValue(await f.tool('flux_reply_in_conversation', { ...envelope, clientCommandId: randomUUID(), conversationId: people.id, message: { body: 'The existing v1 reply still works.' } }));
  assert.equal(allowed.conversationId, people.id); assert.equal(await f.used(replyGrant.id), 1);
  const row = (await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [posted.conversationId])).rows[0]; assert.equal(row.n, 1);
});

test('0072 people/history survives upgrade; reversal refuses a thread and restores cleanly without one', async () => {
  const f = await scene(); const old = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: 'Historical people text', clientMessageId: randomUUID() } }), 201) as { id: string };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Other tests may retain agent threads; only this private transaction removes them for reversal.
    await client.query("DELETE FROM project_conversations WHERE space='agents'");
    const down = await readFile('packages/db/migrations/reverse/0082_agent_threads.down.sql', 'utf8');
    const up = await readFile('packages/db/migrations/0082_agent_threads.sql', 'utf8');
    const ledger = (await client.query('SELECT version FROM flux_schema_version ORDER BY version')).rows;
    await client.query(down); await client.query(up);
    assert.equal((await client.query('SELECT space FROM project_conversations WHERE id=$1', [old.id])).rows[0].space, 'people');
    assert.equal((await client.query('SELECT body FROM project_messages WHERE conversation_id=$1', [old.id])).rows[0].body, 'Historical people text');
    await client.query('INSERT INTO project_conversations(id,workspace_id,project_id,created_by,space,work_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), f.ws.id, f.place.id, f.owner.id, 'agents', f.task.id]);
    await client.query('SAVEPOINT reversal_refusal');
    await assert.rejects(() => client.query(down), /Cannot reverse 0082/); await client.query('ROLLBACK TO SAVEPOINT reversal_refusal');
    assert.deepEqual((await client.query('SELECT version FROM flux_schema_version ORDER BY version')).rows, ledger);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('a new thread post versus unused AI-task Undo has one winner under the shared real fence', async () => {
  const f = await actionScene(pool); const createGrant = await f.grant('work.create', 'execute');
  const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId: createGrant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Unused thread race' } }));
  const item = await f.read(String(created.workId)) as unknown as WorkItem;
  const [post, undo] = await Promise.all([
    f.owner.request('POST', `/api/v1/work/${item.id}/agent-thread`, { body: { body: 'The first actual use.', clientMessageId: randomUUID() } }),
    f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } }),
  ]);
  assert.ok((post.status === 201 && undo.status === 409) || (post.status === 409 && undo.status === 200), `exactly one wins: post=${post.status}, undo=${undo.status}`);
  const row = (await pool.query('SELECT creation_reverted_at,first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0];
  const threads = (await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE work_id=$1', [item.id])).rows[0].n;
  if (post.status === 201) { assert.equal(undo.status, 409); assert.ok(row.first_persisted_use_at); assert.equal(row.creation_reverted_at, null); assert.equal(threads, 1); }
  else { expect(undo, 200) as unknown as UndoTaskCreationResult; assert.ok(row.creation_reverted_at); assert.equal(row.first_persisted_use_at, null); assert.equal(threads, 0); }
});
