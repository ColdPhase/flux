import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  INBOX_PATH, NEEDS_YOU_PATH, SEARCH_PATH, inboxItemPath, projectObjectNoticesPath, projectTaskNoticesPath, taskAgentPath, taskPeoplePath,
  type ConversationRootWindow, type InboxItem, type InboxResponse, type NeedsYouResponse, type ObjectNotice, type Page, type ProjectPerson, type SearchResponse,
  type TaskAgentState, type TaskCreationNotice, type TaskDiscussion, type TaskPeople, type WorkDetailProjection, type WorkItem, type WorkReferenceRows,
} from '@flux/contracts';
import { conversationUseCases, type Principal } from '@flux/core';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { ensureSpaceAiAllowed } from './support/space-ai.js';
import { waitFor } from './support/wait.js';

// An agent's colour is part of the agent as every reader gets it (final design §2, #1528): its owner's teammate sees the owner's agent in the
// same colour the owner does, wherever the agent appears: a task's owner, its agent line and the people in it, a message's author in a space's
// conversation and a task's discussion, a decision it proposed in the Inbox and Needs you, and Search. (An encrypted company has no agent with a
// colour: AI is always off there, WORKSPACE_ENCRYPTED_AI_OFF, so its agents are local clients' identities, drawn in ink for everyone.)

const connections = new FakeConnections();
const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections, providerEnabled: true });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const get = async <T>(who: Person, path: string): Promise<T> => expectStatus(await who.browser.request('GET', path), 200, `GET ${path}`) as T;

/** An agent identity of `owner`, with no AI setup yet. */
async function agentOf(owner: Person, workspaceId: string, name: string): Promise<string> {
  return (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
}

/** Gives `owner`'s agent its AI setup, in `colour` (set as the database holds it, so the test knows which one to expect). */
async function setUpAgent(owner: Person, agent: { id: string }, colour: string) {
  const connection = randomUUID();
  connections.connect(owner.id, connection);
  await runs.enable(human(owner), { agentId: agent.id, connection, model: 'claude-sonnet-5' });
  await pool.query('UPDATE assistant_settings SET colour = $2 WHERE agent_id = $1', [agent.id, colour]);
}

describe('every reader gets an agent in its own colour (#1528)', () => {
  let owner: Person; let reader: Person;
  let projectId = ''; let agentId = ''; let task: WorkItem;
  before(async () => {
    const [manager, ines, wren] = await Promise.all(['Colour Teo', 'Colour Ines', 'Colour Wren'].map(person));
    owner = ines!; reader = wren!;
    const ws = await workspace(manager!, 'Colour company');
    await addMember(manager!, ws.id, owner, 'member');
    await addMember(manager!, ws.id, reader, 'member');
    projectId = (await project(manager!, ws.id, 'Weather station', 'restricted')).id;
    await grant(manager!, projectId, owner, 'contributor');
    await grant(manager!, projectId, reader, 'contributor');
    await ensureSpaceAiAllowed(projectId);
    agentId = await agentOf(owner, ws.id, 'Planner');
    // The task is the agent's before the agent runs on the server, and its assignment is handled first (#856): an agent with its setup would
    // take the task, and on this stack (no model connection) give it straight back to its owner, so the task would no longer be the agent's.
    task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/work`, {
      body: { title: 'Calibrate the rain gauge', owner: { kind: 'agent', id: agentId } },
    }), 201) as WorkItem;
    await waitFor(async () => Number((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_task_events WHERE work_id = $1 AND handled_at IS NULL',
      [task.id])).rows[0]!.n) === 0, 'the assignment is handled');
    await setUpAgent(owner, { id: agentId }, 'plum');
  });

  test('a task\'s owner, its agent line and the people in it', async () => {
    for (const who of [owner, reader]) {
      const { items } = await get<WorkReferenceRows>(who, `/api/v1/projects/${projectId}/work-reference-rows?objects=work:${task.id}`);
      const row = items[0];
      assert.ok(row?.kind === 'work' && row.owner?.kind === 'agent');
      assert.equal(row.owner.colour, 'plum', 'the task row names its agent owner in its colour');
      const { object } = await get<WorkDetailProjection>(who, `/api/v1/projects/${projectId}/work-objects/work/${task.id}`);
      assert.ok(object.kind === 'work' && object.owner?.kind === 'agent' && object.owner.id === agentId, 'the task is still the agent\'s');
      assert.equal(object.owner.colour, 'plum', 'the task panel too');
      const line = await get<TaskAgentState>(who, taskAgentPath(task.id));
      assert.deepEqual([line.agent?.id, line.agent?.colour], [agentId, 'plum'], 'the task\'s agent line');
      const people = await get<TaskPeople>(who, taskPeoplePath(task.id));
      assert.equal(people.people.flatMap((entry) => entry.agents).find((agent) => agent.id === agentId)?.colour, 'plum', 'In this task');
    }
    const space = await get<ProjectPerson[]>(reader, `/api/v1/projects/${projectId}/people`);
    assert.equal(Object.hasOwn(space.find((entry) => entry.id === reader.id)!, 'colour'), false, 'a person has no colour');
  });

  test('its messages in the space\'s conversation and the task\'s discussion, its decision in the Inbox and Needs you, and Search', async () => {
    const actor = { kind: 'agent' as const, id: agentId };
    const word = Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join('');
    const remark = (await conversationUseCases(conversationStore(db, { agentAuthors: true }))
      .createConversation(actor, projectId, { body: `Gauge reads ${word}`, clientMessageId: randomUUID() })).messages[0]!;
    await taskDiscussionUseCases(db).contribute(actor, task.id, { body: 'Calibrated against the reference gauge.', clientMessageId: randomUUID() });
    for (const who of [owner, reader]) {
      const stream = await get<ConversationRootWindow>(who, `/api/v1/projects/${projectId}/conversation-roots`);
      const root = stream.roots.find((item) => item.message.id === remark.id);
      assert.ok(root && root.message.authorId === null, 'the agent\'s remark is a root of the stream');
      assert.equal(root.message.author.colour, 'plum', 'the conversation draws its face in its colour');
      const discussion = await get<TaskDiscussion>(who, `/api/v1/work/${task.id}/discussion`);
      const said = [discussion.root, ...discussion.messages].find((message) => message?.authorId === null);
      assert.equal(said?.authorId === null ? said.author.colour : null, 'plum', 'the task\'s discussion too');
    }
    // A decision the agent proposes about Wren's task reaches Wren (its work's owner): Needs you and the Inbox name the agent with its colour.
    const wrens = expectStatus(await reader.browser.request('POST', `/api/v1/projects/${projectId}/work`, {
      body: { title: 'Move the gauge off the shed roof', owner: { kind: 'human', id: reader.id } } }), 201) as WorkItem;
    const decision = await workUseCases(db).proposeDecision(actor, projectId, { title: 'Use the bed gauge as the reference', affects: [wrens.id] });
    const note = await waitFor(async () => (await get<NeedsYouResponse>(reader, NEEDS_YOU_PATH)).items.find((item) => item.decision?.id === decision.id),
      'the proposal reaches Wren');
    assert.deepEqual([note.decision?.proposedBy.kind, note.decision?.proposedBy.colour], ['agent', 'plum'], 'Needs you: who proposed it');
    assert.deepEqual([note.from?.kind, note.from?.colour], ['agent', 'plum'], 'Needs you: its face');
    // The notification of it (the notice's face reads the one item, #1243).
    const notification = await waitFor(async () => (await pool.query<{ id: string }>(`SELECT id FROM notifications WHERE user_id = $1 AND reason = 'review'
      AND url LIKE $2`, [reader.id, `%decision:${decision.id}`])).rows[0], 'the proposal is a notification of Wren\'s');
    const one = await get<InboxItem>(reader, inboxItemPath(notification.id));
    assert.deepEqual([one.from?.kind, one.from?.id, one.from?.colour], ['agent', agentId, 'plum'], 'the notice\'s face (one item)');
    const listed = (await get<InboxResponse>(reader, `${INBOX_PATH}?limit=50`)).items.find((item) => item.id === notification.id);
    if (listed?.from) assert.equal(listed.from.colour, 'plum', 'the Inbox list');
    // Search: the agent's message is its face in its colour.
    const wrenWord = Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join('');
    expectStatus(await reader.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body: `Wren notes ${wrenWord}`, clientMessageId: randomUUID() } }), 201);
    const found = await waitFor(async () => (await get<SearchResponse>(reader, `${SEARCH_PATH}?q=${word}`)).items.find((item) => item.kind === 'message'), 'the remark is found');
    assert.equal(found.agentColour, 'plum', 'the search result');
    // The row's tile is told by the result, not guessed from how its author's name reads (a person may be named "Planner · Ada's agent").
    assert.equal(found.byAgent, true, 'the agent\'s result says it is an agent\'s');
    const mine = await waitFor(async () => (await get<SearchResponse>(reader, `${SEARCH_PATH}?q=${wrenWord}`)).items.find((item) => item.kind === 'message'), 'Wren\'s own remark is found');
    assert.equal(Object.hasOwn(mine, 'byAgent'), false, 'a person\'s result does not');
  });

  test('every reader is told whose agent it is: its created-task line, its proposed-decision line and the Inbox name its owner (v0.2.1 release gate J03/J10/M41)', async () => {
    const actor = { kind: 'agent' as const, id: agentId };
    const made = await workUseCases(db).createWork(actor, projectId, { title: 'Order the spare gauge' });
    const wrens = expectStatus(await reader.browser.request('POST', `/api/v1/projects/${projectId}/work`, {
      body: { title: 'Paint the gauge post', owner: { kind: 'human', id: reader.id } } }), 201) as WorkItem;
    const decision = await workUseCases(db).proposeDecision(actor, projectId, { title: 'Paint the post white', affects: [wrens.id] });
    for (const who of [owner, reader]) {
      const created = (await get<Page<TaskCreationNotice>>(who, `${projectTaskNoticesPath(projectId)}?limit=50`)).items.find((item) => item.workId === made.id);
      assert.deepEqual(created?.createdBy.projectOwner, { kind: 'human', id: owner.id }, 'the created-task line names its owner');
      const proposed = (await get<Page<ObjectNotice>>(who, `${projectObjectNoticesPath(projectId)}?limit=50`)).items.find((item) => item.decisionId === decision.id);
      assert.deepEqual(proposed?.by.projectOwner, { kind: 'human', id: owner.id }, 'the proposed-decision line names its owner');
    }
    // Wren's Inbox (and Home, which lists it): "from Planner · Colour's agent", never a bare "Planner".
    const note = await waitFor(async () => (await get<NeedsYouResponse>(reader, NEEDS_YOU_PATH)).items.find((item) => item.decision?.id === decision.id),
      'the proposal reaches Wren');
    assert.deepEqual([note.from?.kind, note.from?.name, note.from?.owner], ['agent', 'Planner', { id: owner.id, name: 'Colour Ines' }]);
  });
});
