import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TaskAgentThread, ConversationMessage, WorkItem, Page, ConversationSummary, UndoTaskCreationResult, ProjectExport, SearchResponse, ReturnSummary, InboxResponse } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { taskAgentThreadUseCases } from '@flux/core';
import type pg from 'pg';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { db, pool, connectionString } from './support/db.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

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
    const guardDown = await readFile('packages/db/migrations/reverse/0087_agent_thread_turn_guard.down.sql', 'utf8');
    const guardUp = await readFile('packages/db/migrations/0087_agent_thread_turn_guard.sql', 'utf8');
    await client.query(guardDown);
    // Other tests may retain agent threads; only this private transaction removes them for reversal.
    await client.query("DELETE FROM project_conversations WHERE space='agents'");
    const down = await readFile('packages/db/migrations/reverse/0082_agent_threads.down.sql', 'utf8');
    const up = await readFile('packages/db/migrations/0082_agent_threads.sql', 'utf8');
    const ledger = (await client.query('SELECT version FROM flux_schema_version ORDER BY version')).rows;
    await client.query(down); await client.query(up); await client.query(guardUp);
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

test('new thread GET is a read-only snapshot when a post and access revocation commit between count and window', async () => {
  const f = await scene();
  expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: 'Before the read', clientMessageId: randomUUID() } }), 201);
  const database = createDatabase(connectionString); const statements: string[] = [];
  let held = false;
  database.pool.on('connect', (client: pg.PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args) => {
      const config = args[0]; const text = typeof config === 'string' ? config : (config as { text?: string })?.text ?? '';
      statements.push(text);
      const result = await query(...args);
      if (!held && /^select count\(\*\)::int from "project_messages"/i.test(text)) {
        held = true;
        // The real count has completed; the real page has not started. These commands really commit.
        expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: 'Committed during the read', clientMessageId: randomUUID() } }), 201);
        await grant(f.owner, f.place.id, f.writer, 'denied');
      }
      return result;
    };
  });
  try {
    const observed = await conversationStore(database.db).getAgentThread({ kind: 'human', id: f.writer.id }, f.task.id, { limit: 50, beforeSequence: null });
    assert.ok(held, 'actual count-to-window barrier ran');
    assert.equal(observed.messageCount, 1); assert.equal(observed.conversation?.messages.length, 1);
    assert.equal(observed.conversation?.messages[0]?.body, 'Before the read'); assert.equal(observed.canWrite, true);
    assert.match(statements.find(s => /^begin/i.test(s)) ?? '', /repeatable read.*read only/i);
    assert.equal((await f.writer.browser.request('GET', f.path)).status, 404, 'a new request uses the newly revoked audience');
    assert.equal((expectStatus(await f.owner.browser.request('GET', f.path), 200) as TaskAgentThread).messageCount, 2);
    const before = (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.task.id])).rows;
    await f.owner.browser.request('GET', f.path);
    assert.deepEqual((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.task.id])).rows, before, 'GET never marks another use');
  } finally { await database.pool.end(); }
});

test('agent-thread search has exact task/message targets; hidden matches do not rank, count or page', async () => {
  const f = await scene(); const token = 'threadneedle' + randomUUID().replaceAll('-', '');
  const messages: ConversationMessage[] = [];
  for (let i = 0; i < 3; i++) messages.push(expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: `${token} visible observation ${i}`, clientMessageId: randomUUID() } }), 201) as ConversationMessage);
  const hidden = await project(f.owner, f.ws.id, token + ' hidden project', 'restricted');
  const hiddenTask = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${hidden.id}/work`, { body: { title: 'Private measurements' } }), 201) as WorkItem;
  expectStatus(await f.owner.browser.request('POST', `/api/v1/work/${hiddenTask.id}/agent-thread`, { body: { body: `${token} ${token} ${token} HIDDEN`, clientMessageId: randomUUID() } }), 201);
  const query = new URLSearchParams({ q: token, type: 'message', limit: '1' });
  const get = async (who = f.viewer) => expectStatus(await who.browser.request('GET', `/api/v1/search?${query}`), 200) as SearchResponse;
  const first = await get(); assert.equal(first.items.length, 1); assert.equal(first.counts.message, 3);
  const found: string[] = [];
  let answer = first;
  for (;;) {
    for (const hit of answer.items) {
      assert.equal(hit.label, `Agents’ thread · #${f.task.number}`);
      assert.ok(hit.target.type === 'agent_thread');
      assert.deepEqual(hit.target, { type: 'agent_thread', projectId: f.place.id, taskId: f.task.id, conversationId: messages[0]!.conversationId, messageId: hit.target.messageId });
      found.push(hit.target.messageId); assert.ok(!JSON.stringify(hit).includes('HIDDEN'));
    }
    if (!answer.next) break;
    query.set('cursor', answer.next); answer = await get(); assert.equal(answer.counts.message, 3);
  }
  assert.deepEqual(found.sort(), messages.map(m => m.id).sort());
  query.delete('cursor');
  assert.deepEqual((await get(f.outsider)).counts, {});
  await grant(f.owner, f.place.id, f.viewer, 'denied');
  const revoked = await get(); assert.deepEqual(revoked.items, []); assert.deepEqual(revoked.counts, {});
});

test('format-1 export adds agentThreads while preserving people history and manager/privacy rules', async () => {
  const f = await scene();
  const old = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: 'Original people history', clientMessageId: randomUUID() } }), 201) as { id: string };
  const message = expectStatus(await f.writer.browser.request('POST', f.path, { body: { body: 'Task progress kept in its own thread', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const document = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.place.id}/export?format=json`), 200) as ProjectExport;
  assert.equal(document.formatVersion, 1);
  assert.deepEqual(document.conversations.map(c => c.id), [old.id]);
  assert.equal(document.conversations[0]?.messages[0]?.body, 'Original people history');
  assert.equal(document.agentThreads.length, 1); assert.equal(document.agentThreads[0]?.workId, f.task.id);
  assert.equal(document.agentThreads[0]?.messages[0]?.id, message.id);
  assert.deepEqual(document.agentThreads[0]?.messages[0]?.author, { kind: 'human', id: f.writer.id });
  assert.ok(document.people.some(p => p.id === f.writer.id));
  // A legacy version-1 consumer reads its old fields and ignores additive ones.
  const legacy = (input: Pick<ProjectExport, 'format' | 'formatVersion' | 'project' | 'conversations'>) => input.conversations.map(c => c.messages.map(m => m.body));
  assert.deepEqual(legacy(document), [['Original people history']]);
  for (const p of [f.writer, f.viewer]) assert.equal((await p.browser.request('GET', `/api/v1/projects/${f.place.id}/export?format=json`)).status, 403);
  assert.equal((await f.outsider.browser.request('GET', `/api/v1/projects/${f.place.id}/export?format=json`)).status, 404);
});

test('three quiet progress posts change no Since-you-left, Inbox unread or push; an explicit mention reaches only an authorized reader', async () => {
  const f = await scene(); const recipient = await subscribe(f.viewer.browser);
  expectStatus(await f.viewer.browser.request('PATCH', '/api/v1/notification-preferences', { body: { channels: { reply: { inApp: true, push: true, email: false }, mention: { inApp: true, push: true, email: false } } } }), 200);
  const returned = async (place: string) => expectStatus(await f.viewer.browser.request('GET', '/api/v1/return?' + place), 200) as ReturnSummary;
  for (const [place, actual] of [['place=home', { type: 'home' }], [`place=project&id=${f.place.id}`, { type: 'project', id: f.place.id }]] as const) {
    const seen = await returned(place); expectStatus(await f.viewer.browser.request('PUT', '/api/v1/return-points', { body: { place: actual, mark: seen.mark } }), 200);
  }
  const inbox = async () => expectStatus(await f.viewer.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
  const initialInbox = await inbox(), initialPush = await recordedPushes(recipient.subscription.mockId);
  for (let i = 0; i < 3; i++) expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: `Quiet progress ${i}`, clientMessageId: randomUUID() } }), 201);
  const caughtUp = async () => { const target = Number((await pool.query('SELECT max(seq) AS seq FROM events')).rows[0].seq); await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id='generator'")).rows[0].seq) >= target, 'quiet thread event generation'); };
  await caughtUp();
  assert.deepEqual((await returned('place=home')).items, []); assert.deepEqual((await returned(`place=project&id=${f.place.id}`)).items, []);
  assert.deepEqual(await inbox(), initialInbox); assert.deepEqual(await recordedPushes(recipient.subscription.mockId), initialPush);
  const mention = expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: '@thread-viewer, the comparison is ready. @thread-outsider', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  await caughtUp();
  const item = (await inbox()).items.find(item => item.url?.endsWith(mention.id)); assert.equal(item?.reason, 'mention');
  assert.ok(item?.url?.includes(`open=work:${f.task.id}&agentThread=1`));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND url LIKE $2', [f.outsider.id, `%${mention.id}`])).rows[0].n, 0);
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Thread race barrier exceeded 10s')), 10_000); })]); }
  finally { clearTimeout(timer); }
}
async function unusedAgentTask() {
  const f = await actionScene(pool); const grant = await f.grant('work.create', 'execute');
  const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId: grant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Deterministic thread/Undo trial' } }));
  const item = await f.read(String(created.workId)) as unknown as WorkItem;
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  return { ...f, item, ownerId, path: `/api/v1/work/${item.id}/agent-thread` };
}

test('forced thread-post winner makes actual HTTP Undo wait then refuse; a retry adds no second use/event', { timeout: 30_000 }, async () => {
  const f = await unusedAgentTask(); const held = barrier<number>(), release = barrier();
  const command = { body: 'First actual thread effect', clientMessageId: randomUUID() };
  let undo: ReturnType<typeof f.owner.request> | undefined;
  const post = db.transaction(async tx => {
    const saved = await taskAgentThreadUseCases(conversationStore(tx)).post({ kind: 'human', id: f.ownerId }, f.item.id, command);
    held.resolve(await backendPid(tx)); await bounded(release.promise); return saved;
  }); void post.catch(() => undefined);
  try {
    const pid = await bounded(held.promise);
    undo = f.owner.request('POST', `/api/v1/work/${f.item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: f.item.version } });
    void undo.catch(() => undefined); await waitUntilBlockedBy(pool, pid); release.resolve();
    const saved = await bounded(post); assert.equal((await bounded(undo)).status, 409);
    assert.deepEqual(expect(await f.owner.request('POST', f.path, { body: command }), 201), saved);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND kind='project.agent_thread_message_sent.v1'", [f.projectId])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [f.item.id])).rows[0].n, 0);
  } finally { release.resolve(); await bounded(Promise.all([post.catch(() => undefined), undo?.catch(() => undefined)])); }
});

test('forced Undo winner makes actual HTTP first post wait then refuse without thread, message or usage latch', { timeout: 30_000 }, async () => {
  const f = await unusedAgentTask(); const held = barrier<number>(), release = barrier();
  let post: ReturnType<typeof f.owner.request> | undefined;
  const undo = db.transaction(async tx => {
    const native = nativeWorkInTransaction(tx);
    const result = await native.undoTaskCreation({ kind: 'human', id: f.ownerId }, f.item.id, { clientCommandId: randomUUID(), expectedVersion: f.item.version });
    held.resolve(await backendPid(tx)); await bounded(release.promise); await native.flushEvents(); return result;
  }); void undo.catch(() => undefined);
  try {
    const pid = await bounded(held.promise);
    post = f.owner.request('POST', f.path, { body: { body: 'A late thread', clientMessageId: randomUUID() } }); void post.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(undo); assert.equal((await bounded(post)).status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE work_id=$1', [f.item.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.item.id])).rows[0].first_persisted_use_at, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND kind='project.agent_thread_message_sent.v1'", [f.projectId])).rows[0].n, 0);
  } finally { release.resolve(); await bounded(Promise.all([undo.catch(() => undefined), post?.catch(() => undefined)])); }
});

test('rollback removes a persisted thread/message/event and the shared first-use latch together', async () => {
  const f = await scene(); const sentinel = new Error('Injected outer rollback');
  await assert.rejects(db.transaction(async tx => {
    await taskAgentThreadUseCases(conversationStore(tx)).post({ kind: 'human', id: f.owner.id }, f.task.id,
      { body: 'This effect must roll back', clientMessageId: randomUUID() });
    throw sentinel;
  }), sentinel);
  assert.equal(await f.count(), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [f.place.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.task.id])).rows[0].first_persisted_use_at, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND kind='project.agent_thread_message_sent.v1'", [f.place.id])).rows[0].n, 0);
});
