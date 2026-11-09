import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { assistantChangeActionPath, conversationAssistantChangesPath, taskDiscussionPath, type AssistantChange, type AssistantChangeDecision, type Conversation, type TaskDiscussion } from '@flux/contracts';
import { pool } from './support/db.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';

// A line any agent of a person puts in a task's thread is that person's to delete, whoever answered it since (TA-3, #938). That is the
// run's own lines (agent-task-threads.test.ts) and also the replies of the person's local client or assistant (#961): the server marks
// them as thread lines when it records them, so the Delete the task panel offers is the same Delete for all of them. A post in an
// ordinary conversation is not an agent's line at all: it is its owner's own message, marked via the client (#1091).

test('#961: a reply a local client puts in a task\'s thread is its owner\'s to delete after a person answered it; in another conversation it is the owner\'s own message', async () => {
  const f = await actionScene(pool);
  const command = (extra: Record<string, unknown>) => ({ projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], ...extra });
  const changesOf = async (conversationId: string) => (expect(await f.owner.request('GET', conversationAssistantChangesPath(conversationId)), 200) as unknown as { items: AssistantChange[] }).items;
  const name = String((await pool.query('SELECT name FROM auth_users WHERE id = (SELECT owner_user_id FROM agent_connections WHERE id = $1)', [f.connectionId])).rows[0].name);

  const task = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Discuss the baseline' } }), 201);
  expect(await f.owner.request('POST', taskDiscussionPath(String(task.id)), { body: { body: 'Where do we start?', clientMessageId: randomUUID() } }), 201);
  const talk = expect(await f.owner.request('GET', taskDiscussionPath(String(task.id))), 200) as unknown as TaskDiscussion;
  const reply = toolValue(await f.tool('flux_reply_in_conversation', command({ conversationId: talk.conversationId, message: { body: 'The baseline is four hours.' } })));
  // The owner answers it. The Undo that waits for silence would now refuse; a line in a task's thread is deleted whatever came after.
  expect(await f.owner.request('POST', taskDiscussionPath(String(task.id)), { body: { body: 'Good, thanks', clientMessageId: randomUUID() } }), 201);
  const change = (await changesOf(talk.conversationId!)).find((item) => item.operation === 'conversation.reply' && item.objectId === String(reply.messageId));
  assert.ok(change?.undoable, 'its owner is offered the delete');
  const deleted = expect(await f.owner.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} }), 200) as unknown as AssistantChangeDecision;
  assert.equal(deleted.message, null);
  assert.deepEqual([deleted.change.state, deleted.change.line], ['undone', `Removed by ${name}`]);
  const after = expect(await f.owner.request('GET', taskDiscussionPath(String(task.id))), 200) as unknown as TaskDiscussion;
  const bodies = [after.root, ...after.messages].filter(Boolean).map((message) => message!.body);
  assert.ok(bodies.includes('[Removed]') && !bodies.includes('The baseline is four hours.'), 'a marker keeps its place');
  assert.ok(bodies.includes('Good, thanks'), 'and the owner\'s own line stays');
  assert.ok(!JSON.stringify((await pool.query('SELECT receipt, object_title FROM assistant_changes WHERE id = $1', [change!.id])).rows[0]).includes('baseline is four'), 'nothing of the text is left in the change');

  // An ordinary conversation of the space is people's: the client's start is its owner's own message, marked via the client (LC-2, #1091). It has no
  // change line and no Undo; its owner deletes it as theirs.
  const started = toolValue(await f.tool('flux_start_conversation', command({ peerRequestClass: 'plan', message: { body: 'Is the baseline stable?' } })));
  const conversationId = String(started.conversationId);
  expect(await f.owner.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body: 'Yes', clientMessageId: randomUUID() } }), 201);
  assert.equal((await changesOf(conversationId)).find((item) => item.objectId === String(started.messageId)), undefined, 'the opening line has no change');
  const opening = (expect(await f.owner.request('GET', `/api/v1/conversations/${conversationId}`), 200) as unknown as Conversation).messages[0]!;
  assert.deepEqual([opening.authorId === (await pool.query('SELECT owner_user_id FROM agent_connections WHERE id = $1', [f.connectionId])).rows[0].owner_user_id, opening.via], [true, 'Test client']);
});
