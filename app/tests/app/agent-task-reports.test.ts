import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { assistantRunChangesActionPath, taskDiscussionPath, type TaskDiscussion } from '@flux/contracts';
import { reportTaskRun, stopRunBy } from '@flux/core';
import { personalRunPorts } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { assistantScene, human, text, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { expectStatus } from './support/people.js';

// An agent's reports arrive in its private chat (#919, F-036 AG-7): when a run on a task ends, one line, once, unread until its owner opens the
// chat, with Undo while the run's changes stand. Reports never go to the Inbox. Fake compute: no provider pass is claimed.

describe('the report of a run on a task (#919)', () => {
  let scene: AssistantScene;
  const chat = async () => scene.runs.agentChatMessages(human(scene.owner), scene.agentId);
  const unread = async () => (await scene.runs.agentChats(human(scene.owner))).find((item) => item.agentId === scene.agentId)!.unread;

  /** A task of Ada's with its discussion open, and a run of her agent on it, started the way an assignment starts it. */
  async function started(title: string) {
    const task = await scene.task(scene.owner, title);
    expectStatus(await scene.owner.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Go ahead', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await scene.owner.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const begun = await db.transaction((tx) => scene.runs.startTask(personalRunPorts(tx, scene.queue.factory), { ownerUserId: scene.owner.id, agentId: scene.agentId, workId: task.id,
      projectId: scene.place.id, conversationId: talk.conversationId!, prompt: `Task #${task.number}: ${title}`, clientRunId: randomUUID() }));
    assert.ok(begun.started, JSON.stringify(begun));
    return { task, run: begun.run };
  }

  before(async () => {
    scene = await assistantScene('rep');
    await scene.runs.readAgentChat(human(scene.owner), scene.agentId);
  });

  test('a run that ends with an answer reports once: Done, the task, unread until the chat is opened, and never in the Inbox', async () => {
    const { task, run } = await started('Check the lamp wiring');
    scene.compute.respond = async () => ({ kind: 'completed', text: 'Checked the wiring: it is sound.', stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 20 } });
    assert.equal(await scene.processor.process(run.id), 'completed');
    assert.deepEqual((await chat()).map((line) => [line.runId, line.body, line.changes]), [[run.id, `Done: #${task.number} Check the lamp wiring`, 0]]);
    assert.equal(await unread(), 1);
    // The same end told again posts nothing more.
    await personalRunWorkerUnitOfWork(db).run(async (ports) => reportTaskRun(ports, (await ports.runs.findRun(run.id))!));
    assert.equal((await chat()).length, 1);
    // Reports are the chat's, not the Inbox's: no notification of the owner is about this run or says it.
    const inbox = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND (title ILIKE '%Done:%' OR body ILIKE '%Done:%' OR url LIKE $2)`, [scene.owner.id, `%${run.id}%`]);
    assert.equal(inbox.rowCount, 0);
    await scene.runs.readAgentChat(human(scene.owner), scene.agentId);
    assert.equal(await unread(), 0);
  });

  test('the line carries the changes that stand now, and they stand only until they are undone', async () => {
    const { task, run } = await started('Tidy the sensor tasks');
    // The run works through the same tools as an owner's request: it makes one child task. (The scene's live run is an owner's request; it
    // becomes this task's run, so the change it makes is one of the run on the task.)
    const live = await scene.liveRun();
    await pool.query(`UPDATE personal_runs SET kind = 'task', work_id = $2, agent_id = $3 WHERE id = $1`, [live.runId, task.id, scene.agentId]);
    const made = JSON.parse(text((await live.call('flux_create_task', { task: { title: 'Replace the corroded probe', parentTaskId: task.id } })).message)) as { workId: string };
    assert.ok(made.workId);
    await scene.complete(live.runId);
    await personalRunWorkerUnitOfWork(db).run(async (ports) => reportTaskRun(ports, (await ports.runs.findRun(live.runId))!));
    const line = (await chat()).find((item) => item.runId === live.runId)!;
    assert.equal(line.body, `Done: #${task.number} Tidy the sensor tasks`);
    assert.equal(line.changes, 1, 'the chat adds "· 1 change · Undo" while the change stands');
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(live.runId, 'undo'), { body: {} }), 200);
    assert.equal((await chat()).find((item) => item.runId === live.runId)!.changes, 0, 'nothing left to undo');
    void run;
  });

  test('a stop reports who stopped it, and a run that is not on a task reports nothing', async () => {
    const { task, run } = await started('Compare the last readings');
    await scene.runs.stop(human(scene.owner), run.id);
    assert.equal((await chat()).find((item) => item.runId === run.id)?.body, `Stopped by you: #${task.number} Compare the last readings`);
    // Another person's stop is named.
    const other = await started('Compare the weekly readings');
    // The space's admin stops it from the task (the owner's own Stop is the call above): the report names that person.
    await personalRunWorkerUnitOfWork(db).run((ports) => stopRunBy(ports, other.run.id, scene.lead.id));
    const leadName = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [scene.lead.id])).rows[0].name as string;
    assert.equal((await chat()).find((item) => item.runId === other.run.id)?.body, `Stopped by ${leadName}: #${other.task.number} Compare the weekly readings`);
    // A run that is not on a task is not reported.
    const before = (await chat()).length;
    const asked = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Hello' });
    scene.compute.respond = async () => ({ kind: 'completed', text: 'Hi', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } });
    assert.equal(await scene.processor.process(asked.run.id), 'completed');
    assert.equal((await chat()).length, before);
  });
});
