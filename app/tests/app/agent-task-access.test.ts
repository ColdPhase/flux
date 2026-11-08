import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { taskDiscussionPath, taskPeoplePath, workItemPath, TASK_TAKING_PATH, type Project, type TaskDiscussion, type TaskPeople, type WorkItem, type Workspace } from '@flux/contracts';
import type { Principal } from '@flux/core';
import { personalRunPorts, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';

// A company owner's or admin's agents work only in the spaces the person was added to (C-15, #934). Agents taking tasks must not forget it
// (#955): a task is not offered to an agent that cannot read the space, and when "Give it to" cannot give a task to the person's agent
// because of it, the person is told in the task. The API containers drain the events (the production composition: no provider, so an
// agent that is asked cannot answer there); what is asserted is what Flux decides and says in the thread.

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

describe('agents of a company admin who is not in the space (C-15, #955)', () => {
  let ari: Person; let mira: Person; let lee: Person;
  let ws: Workspace; let closed: Project;
  const agents: Record<string, string> = {};
  let miraName = '';

  const readTask = async (id: string) => expectStatus(await lee.browser.request('GET', workItemPath(id)), 200) as WorkItem;
  const thread = async (id: string) => {
    const talk = expectStatus(await lee.browser.request('GET', taskDiscussionPath(id)), 200) as TaskDiscussion;
    return [...new Map([talk.root, ...talk.messages].filter(Boolean).map((message) => [message!.id, message!])).values()].sort((a, b) => a.sequence - b.sequence);
  };
  const createTask = async (by: Person, title: string, owner: { kind: 'human' | 'agent'; id: string } | null) =>
    expectStatus(await by.browser.request('POST', `/api/v1/projects/${closed.id}/work`, { body: { title, ...(owner ? { owner } : {}) } }), 201) as WorkItem;

  /** Lee made a task in the closed space, Mira wrote in it, and Lee's agent Planner holds it with a finished report that asks `ask`. */
  async function asked(title: string, ask: string) {
    const task = await createTask(lee, title, null);
    expectStatus(await mira.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'I can help with the readings', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await lee.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { ownerUserId: lee.id, agentId: agents.lee!, workId: task.id, projectId: closed.id,
      conversationId: talk.conversationId!, prompt: `Task #${task.number}: ${title}`, clientRunId: randomUUID() }));
    assert.ok(started.started, JSON.stringify(started));
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, agents.lee]);
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = $2, cost_state = 'released', charged_micros = 0 WHERE id = $1`,
      [started.run.id, `I compared the readings.\n<ask>${ask}</ask>`]);
    return task;
  }

  before(async () => {
    [ari, mira, lee] = await Promise.all(['aac-ari', 'aac-mira', 'aac-lee'].map(person));
    ws = await createWorkspace(ari, 'Tidal club tasks');
    await addMember(ari, ws.id, mira, 'admin');
    await addMember(ari, ws.id, lee, 'member');
    // A closed space only Lee belongs to: Mira (an admin) reaches it, but was never added.
    closed = await createProject(lee, ws.id, 'Closed tides', 'restricted');
    miraName = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [mira.id])).rows[0].name as string;
    for (const [key, someone, name] of [['lee', lee, 'Planner'], ['mira', mira, 'Fieldbot']] as const) {
      agents[key] = (expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
      const connection = randomUUID();
      connections.connect(someone.id, connection);
      await runs.enable(human(someone), { agentId: agents[key]!, connection, model: 'claude-sonnet-5' });
    }
  });

  test('an agent may ask only agents that can read the space: an admin who wrote in the task without being added is not asked', async () => {
    const outside = await asked('Which reading is full?', '{"agent": "Fieldbot", "question": "Which reading means full?"}');
    await waitFor(async () => (await readTask(outside.id)).owner?.kind === 'human', 'the task to go back to Lee');
    const lines = (await thread(outside.id)).map((message) => message.body);
    // Mira is in the task (she wrote in it); what is true is that her agent can't work in this space, and the line says that and no reason
    // (she may be outside the space, a guest or gone from the company).
    assert.ok(lines.includes(`I can't ask Fieldbot (${miraName}'s agent): that agent can't work in this space. This needs a person.`), lines.join(' | '));
    // An agent nobody has is still "not in this task".
    const nobody = await asked('Which reading is full, Ghost?', '{"agent": "Ghost", "question": "Which reading means full?"}');
    await waitFor(async () => (await readTask(nobody.id)).owner?.kind === 'human', 'the task to go back to Lee');
    assert.ok((await thread(nobody.id)).map((message) => message.body).includes('I can\'t ask Ghost: they are not in this task. This needs a person.'));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM personal_runs WHERE work_id = $1 AND kind = 'task_answer'`, [outside.id])).rows[0].n, 0, 'nobody\'s answer run was made, to be refused');
    // Control: once Mira is in the space her agent is in the task, and is asked.
    await grant(mira, closed.id, mira, 'manager');
    const inside = await asked('Which reading is full, now?', '{"agent": "Fieldbot", "question": "Which reading means full?"}');
    await waitFor(async () => (await readTask(inside.id)).owner?.kind === 'human', 'the task to go back to Lee');
    const asking = (await thread(inside.id)).map((message) => message.body);
    assert.ok(asking.includes(`@Fieldbot (${miraName}'s agent), Which reading means full?`), asking.join(' | '));
  });

  test('"In this task" lists the people who can read the space and, of their agents, those that can work there (#924)', async () => {
    const late = await person('aac-late');
    await addMember(ari, ws.id, late, 'member');
    // A space of its own, where Mira (an admin) has not been added.
    const third = await createProject(lee, ws.id, 'Third closed tides', 'restricted');
    await grant(lee, third.id, late, 'contributor');
    const task = expectStatus(await lee.browser.request('POST', `/api/v1/projects/${third.id}/work`, { body: { title: 'Who is in this task' } }), 201) as WorkItem;
    for (const writer of [mira, late]) expectStatus(await writer.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Me too', clientMessageId: randomUUID() } }), 201);
    const listed = async () => Object.fromEntries((expectStatus(await lee.browser.request('GET', taskPeoplePath(task.id)), 200) as TaskPeople).people
      .map((entry) => [entry.id, entry.agents.map((agent) => agent.name)]));
    // Mira reaches the space as an admin but was never added: she is in the task, her agent cannot work here and is not offered.
    assert.deepEqual(await listed(), { [lee.id]: ['Planner'], [mira.id]: [], [late.id]: [] });
    // Added to the space, her agent is offered too.
    await grant(lee, third.id, mira, 'manager');
    assert.deepEqual((await listed())[mira.id], ['Fieldbot']);
    // Someone who lost the space is no longer in the task, though what they wrote stays.
    await removeFromSpace(lee, third.id, late);
    assert.deepEqual(Object.keys(await listed()).sort(), [lee.id, mira.id].sort());
    const talk = expectStatus(await lee.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    assert.ok(talk.messages.some((message) => message.authorId === late.id), 'what they wrote stays');
  });

  test('"Give it to": a task given to an admin who is not in the space stays with her, and the thread says why', async () => {
    const second = await createProject(lee, ws.id, 'Second closed tides', 'restricted');
    expectStatus(await mira.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.mira } }), 200);
    try {
      const refused = expectStatus(await lee.browser.request('POST', `/api/v1/projects/${second.id}/work`, { body: { title: 'For Mira', owner: { kind: 'human', id: mira.id } } }), 201) as WorkItem;
      await waitFor(async () => {
        const rows = (await pool.query('SELECT handled_at FROM agent_task_events WHERE work_id = $1', [refused.id])).rows as { handled_at: Date | null }[];
        return rows.length > 0 && rows.every((row) => row.handled_at) ? rows : null;
      }, 'the event to be handled');
      // Her own words, naming the agent she chose, and exactly once.
      const hers = async () => (await thread(refused.id)).filter((message) => message.authorId === mira.id).map((message) => message.body);
      const line = 'My agent Fieldbot can\'t work in this space, so it hasn\'t taken this task. It\'s still with me.';
      assert.deepEqual(await hers(), [line]);
      const now = expectStatus(await lee.browser.request('GET', workItemPath(refused.id)), 200) as WorkItem;
      assert.deepEqual([now.owner?.kind, now.owner?.id], ['human', mira.id], 'the task stays with her');
      // Giving it to her again, and again, is the same refusal and the same line: not one more each time.
      for (const to of [lee, mira]) {
        const current = await readTask(refused.id);
        expectStatus(await lee.browser.request('PATCH', workItemPath(refused.id), { body: { owner: { kind: 'human', id: to.id } }, headers: { 'if-match': `"${current.version}"` } }), 200);
      }
      await waitFor(async () => {
        const rows = (await pool.query(`SELECT handled_at FROM agent_task_events WHERE work_id = $1 AND kind = 'assigned' AND owner_user_id = $2`, [refused.id, mira.id])).rows as { handled_at: Date | null }[];
        return rows.length === 2 && rows.every((row) => row.handled_at) ? rows : null;
      }, 'the second assignment to be handled');
      assert.deepEqual(await hers(), [line], 'still one line');
      // Control: in a space she is in, the same setting gives the task to her agent (which cannot start in this composition and says so).
      const taken = expectStatus(await lee.browser.request('POST', `/api/v1/projects/${closed.id}/work`, { body: { title: 'For Mira in her space', owner: { kind: 'human', id: mira.id } } }), 201) as WorkItem;
      await waitFor(async () => {
        const rows = await thread(taken.id);
        return rows.some((message) => message.body === 'I can\'t start: AI is switched off on this Flux.') ? rows : null;
      }, 'the agent to take it and say it cannot start');
    } finally {
      expectStatus(await mira.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: null } }), 200);
    }
  });
});
