import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { TASK_TAKING_PATH, taskDiscussionPath, workItemPath, type Conversation, type Project, type TaskDiscussion, type Workspace, type WorkItem } from '@flux/contracts';
import { testFixturePersonalConnections } from '@flux/core';
import { createAgentTaskDrain } from '../../apps/server/src/agent-tasks/drain.js';
import { pgBossPersonalRunQueue } from '../../apps/server/src/personal-runs/adapters.js';
import { connectionString, db, pool } from './support/db.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

// Agents taking tasks beside everything else that takes the same locks (#856, review of cb586bbd2). The drains of two API processes and
// two more in this process run on the same events, the worker runs the agent's real runs on the mock provider, the people keep creating
// tasks, and the agent's owner keeps asking his own assistant. A drain that locked the task graph before the owner's enablement row, the
// order the worker and a person's own request do not use, deadlocked with them: the loser's dispatch job was lost, its run stayed
// `dispatching` and the owner's own request answered 500. Here none of that happens: PostgreSQL counts no deadlock, no request fails, no
// run is left and every task the agent was given is its owner's again or Done.
//
// Needs the real worker on the mock provider, so it runs only with FLUX_TEST_PERSONAL_RUNS=anthropic-mock and
// FLUX_TEST_ANTHROPIC_URL=http://providermock:8095 (like space-ai-two-api.test.ts):
//   FLUX_TEST_PERSONAL_RUNS=anthropic-mock FLUX_TEST_ANTHROPIC_URL=http://providermock:8095 ./scripts/check_application.sh tests/app/agent-task-concurrency.test.ts

const live = process.env.FLUX_TEST_PERSONAL_RUNS === 'anthropic-mock';
const RUNNING = ['queued', 'reading', 'dispatching'];
const TASKS = 12;
const OWN_REQUESTS = 6;
const CREATED = 24;

describe('agents taking tasks beside the worker and the owner\'s own requests', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, () => {
  let ada: Person; let kai: Person; let ws: Workspace; let lamp: Project; let thread: Conversation; let agentId: string; let boss: PgBoss;

  const deadlocks = async () => Number((await pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
  const createTask = async (title: string, owner: { kind: 'human'; id: string } | null) => expectStatus(await ada.browser.request('POST', `/api/v1/projects/${lamp.id}/work`,
    { body: { title, ...(owner ? { owner } : {}) } }), 201, `create ${title}`) as WorkItem;
  const ask = (index: number) => kai.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`,
    { body: { clientRunId: randomUUID(), kind: 'ask', prompt: `What is left on the lamp? (${index})` } });

  before(async () => {
    [ada, kai] = await Promise.all([person('atc-ada'), person('atc-kai')]);
    ws = await createWorkspace(ada, 'Concurrent club');
    await addMember(ada, ws.id, kai, 'member');
    lamp = await createProject(ada, ws.id, 'Lamp', 'workspace');
    agentId = (expectStatus(await kai.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'kai planner', owner: 'self' } }), 201) as { id: string }).id;
    const connection = (await testFixturePersonalConnections.resolve(kai.id))!.id;
    expectStatus(await kai.browser.request('POST', '/api/v1/my-agents', { body: { agentId, connection, model: 'claude-sonnet-5' } }), 201);
    thread = expectStatus(await kai.browser.request('POST', `/api/v1/projects/${lamp.id}/conversations`, { body: { body: 'The lamp flickers', clientMessageId: randomUUID() } }), 201) as Conversation;
    expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId } }), 200);
    boss = new PgBoss({ connectionString });
    boss.on('error', () => undefined);
    await boss.start();
  });
  after(async () => { await boss?.stop({ graceful: false }).catch(() => undefined); });

  test('a burst of assignments, task creations and Kai\'s own requests, with four drains and the worker: no deadlock, no lost run, no failed request', async () => {
    const queue = pgBossPersonalRunQueue(boss);
    const extra = [1, 2].map(() => createAgentTaskDrain(db, queue, { connections: testFixturePersonalConnections, providerEnabled: true }));
    const before = await deadlocks();
    const [assigned, created, own] = await Promise.all([
      Promise.all(Array.from({ length: TASKS }, (_, index) => createTask(`Burst ${index}`, { kind: 'human', id: kai.id }))),
      Promise.all(Array.from({ length: CREATED }, (_, index) => createTask(`Meanwhile ${index}`, null))),
      Promise.all(Array.from({ length: OWN_REQUESTS }, (_, index) => ask(index))),
      Promise.all(extra.map((drain) => drain.drain())),
    ]);
    assert.equal(created.length, CREATED, 'every task a person created meanwhile was created');
    assert.deepEqual(own.map((response) => response.status), Array(OWN_REQUESTS).fill(202), `Kai's own requests were all accepted: ${own.map((response) => response.text).join(' | ')}`);
    for (const drain of extra) await drain.drain();

    // Every run the agent made for a task, and every run Kai asked for, ends: none is left waiting for a job that was lost.
    const ids = assigned.map((task) => task.id);
    const left = await waitFor(async () => {
      const rows = (await pool.query(`SELECT status FROM personal_runs WHERE owner_user_id = $1`, [kai.id])).rows as { status: string }[];
      return rows.length >= TASKS + OWN_REQUESTS && !rows.some((row) => RUNNING.includes(row.status)) ? rows : null;
    }, 'every run of Kai to end', 90_000);
    assert.deepEqual([...new Set(left.map((row) => row.status))].sort(), ['completed'], 'the worker finished every run on the mock provider');

    // Every task the agent was given is out of its hands: Done, or back with Kai, to check. None is lost.
    for (const id of ids) {
      await waitFor(async () => {
        const events = (await pool.query(`SELECT handled_at FROM agent_task_events WHERE work_id = $1`, [id])).rows as { handled_at: Date | null }[];
        return events.length > 0 && events.every((row) => row.handled_at) ? true : null;
      }, `the events of ${id} to be handled`, 60_000);
      const now = expectStatus(await ada.browser.request('GET', workItemPath(id)), 200) as WorkItem;
      assert.ok(now.status === 'done' || (now.owner?.kind === 'human' && now.owner.id === kai.id), `${now.title} is Done or back with Kai, not lost with the agent (${now.status}, ${JSON.stringify(now.owner)})`);
      const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(id)), 200) as TaskDiscussion;
      assert.ok([talk.root, ...talk.messages].some((message) => message && message.authorId === null), `${now.title}: the agent said something in the task`);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_task_events WHERE handled_at IS NULL OR attempts > 0`)).rows[0].n, 0, 'no event had to be tried again, none waits');
    // PostgreSQL reports its counters a moment after the transactions end.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(await deadlocks() - before, 0, 'PostgreSQL detected no deadlock');
  });
});
