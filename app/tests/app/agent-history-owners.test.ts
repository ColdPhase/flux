import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation, ConversationMessage, ConversationRootWindow, ProjectPerson, TaskDiscussion, WorkItem } from '@flux/contracts';
import { NotFoundError } from '@flux/core';
import { projectAuthorOwners } from '../../apps/server/src/conversation/author-owners.js';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, removeMember, workspace } from './support/people.js';

async function scene(ownerKind: 'self' | 'workspace' = 'self') {
  const [manager, owner, reader] = await Promise.all(['History manager', 'Visible historical owner', 'History guest'].map(person));
  const ws = await workspace(manager, 'Historical agent ownership');
  await addMember(manager, ws.id, owner, 'member');
  await addMember(manager, ws.id, reader, 'guest');
  const place = await project(manager, ws.id, 'Preserved authors', 'restricted');
  await grant(manager, place.id, owner, 'contributor');
  await grant(manager, place.id, reader, 'viewer');
  const agent = expectStatus(await (ownerKind === 'self' ? owner : manager).browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
    body: { name: 'Historical analyst', owner: ownerKind },
  }), 201) as { id: string };
  const access = expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201) as { id: string };
  const task = expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title: 'Preserve the measured history' },
  }), 201) as WorkItem;
  const command = { body: 'Actual historical contribution.', clientMessageId: randomUUID() };
  const actor = { kind: 'agent' as const, id: agent.id };
  const receipt = await taskDiscussionUseCases(db).contribute(actor, task.id, command);
  const read = async () => {
    const discussion = expectStatus(await reader.browser.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as TaskDiscussion;
    const conversation = expectStatus(await reader.browser.request('GET', `/api/v1/conversations/${receipt.conversationId}`), 200) as Conversation;
    const stream = expectStatus(await reader.browser.request('GET', `/api/v1/projects/${place.id}/conversation-roots`), 200) as ConversationRootWindow;
    return [discussion.root!, discussion.messages[0]!, conversation.messages[0]!, stream.roots[0]!.message];
  };
  return { manager, owner, reader, ws, place, agent, access, task, actor, command, receipt, read };
}

function unchangedIdentity(row: ConversationMessage, receipt: ConversationMessage) {
  assert.equal(row.authorId, null);
  assert.equal(row.author!.id, receipt.author!.id);
  const { projectOwner, ...author } = row.author!;
  void projectOwner;
  assert.deepEqual({ ...row, author }, receipt, 'only the optional display metadata differs from the stored receipt');
}

test('current-project owner remains visible in genuine agent history after grant removal, but deny/member removal clears its ID', async () => {
  const f = await scene();
  const before = (await pool.query('SELECT * FROM project_messages WHERE id=$1', [f.receipt.id])).rows[0];
  const exactReceipt = JSON.stringify(f.receipt);
  assert.equal(Object.hasOwn(f.receipt.author!, 'projectOwner'), false);
  assert.equal(JSON.stringify(await taskDiscussionUseCases(db).contribute(f.actor, f.task.id, f.command)), exactReceipt);
  for (const row of await f.read()) {
    unchangedIdentity(row, f.receipt);
  }
  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  const people = expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/people`), 200) as ProjectPerson[];
  assert.equal(people.some((person) => person.id === f.agent.id), false, 'history does not restore the revoked audience member');
  assert.ok(people.some((person) => person.kind === 'human' && person.id === f.owner.id));
  assert.equal((await f.reader.browser.request('GET', `/api/v1/workspaces/${f.ws.id}/members`)).status, 403);
  for (const row of await f.read()) {
    unchangedIdentity(row, f.receipt);
    assert.deepEqual(row.author!.projectOwner, { kind: 'human', id: f.owner.id });
  }
  await assert.rejects(taskDiscussionUseCases(db).contribute(f.actor, f.task.id, f.command), NotFoundError);
  await grant(f.manager, f.place.id, f.owner, 'denied');
  for (const row of await f.read()) {
    unchangedIdentity(row, f.receipt);
    assert.equal(Object.hasOwn(row.author!, 'projectOwner'), false, 'a hidden owner ID is omitted entirely');
  }
  await grant(f.manager, f.place.id, f.owner, 'contributor');
  for (const row of await f.read()) assert.deepEqual(row.author!.projectOwner, { kind: 'human', id: f.owner.id });
  await removeMember(f.manager, f.ws.id, f.owner);
  for (const row of await f.read()) assert.equal(Object.hasOwn(row.author!, 'projectOwner'), false);
  assert.deepEqual((await pool.query('SELECT * FROM project_messages WHERE id=$1', [f.receipt.id])).rows[0], before);
});

test('workspace-owned historical authors keep an explicit workspace relation; foreign/missing IDs never enter the bounded projection', async () => {
  const f = await scene('workspace');
  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  for (const row of await f.read()) {
    unchangedIdentity(row, f.receipt);
    assert.deepEqual(row.author!.projectOwner, { kind: 'workspace' });
  }
  const other = await workspace(f.manager, 'Unrelated owners');
  const foreign = expectStatus(await f.manager.browser.request('POST', `/api/v1/workspaces/${other.id}/agents`, {
    body: { name: 'Foreign author', owner: 'self' },
  }), 201) as { id: string };
  const projected = await projectAuthorOwners(db, f.place.id, f.ws.id, [foreign.id, randomUUID(), f.agent.id, f.agent.id]);
  assert.deepEqual([...projected], [[f.agent.id, { kind: 'workspace' }]]);
  await assert.rejects(projectAuthorOwners(db, f.place.id, f.ws.id, Array.from({ length: 102 }, () => randomUUID())), /bounded message window/);
});
