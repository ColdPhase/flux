import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { assistantRunChangesActionPath, taskDiscussionPath, type AgentChatMessage, type AssistantRunUndone, type TaskDiscussion } from '@flux/contracts';
import { stopRunBy } from '@flux/core';
import { personalRunPorts } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { assistantScene, human, text, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { expectStatus } from './support/people.js';
import { waitFor } from './support/wait.js';

// An agent's reports arrive in its private chat (#919, F-036 AG-7): when the outcome of a run on a task is known, one line, once, unread
// until its owner opens the chat, with Undo while the run's changes stand. The API container's real drain decides the outcome (Done, or back
// with the owner to check) from the run's end, as it does for any task. Reports never go to the Inbox. Fake compute: no provider pass is claimed.

describe('the report of a run on a task (#919)', () => {
  let scene: AssistantScene;
  const chat = async () => scene.runs.agentChatMessages(human(scene.owner), scene.agentId);
  const unread = async () => (await scene.runs.agentChats(human(scene.owner))).find((item) => item.agentId === scene.agentId)!.unread;
  const reportOf = (runId: string) => waitFor(async () => (await chat()).find((line) => line.runId === runId), `the report of run ${runId}`);

  /** A task of Ada's with its discussion open, held by her agent, and a run of the agent on it, started the way an assignment starts it. */
  async function started(title: string) {
    const task = await scene.task(scene.owner, title);
    expectStatus(await scene.owner.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Go ahead', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await scene.owner.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const begun = await db.transaction((tx) => scene.runs.startTask(personalRunPorts(tx, scene.queue.factory), { ownerUserId: scene.owner.id, agentId: scene.agentId, workId: task.id,
      projectId: scene.place.id, conversationId: talk.conversationId!, prompt: `Task #${task.number}: ${title}`, clientRunId: randomUUID() }));
    assert.ok(begun.started, JSON.stringify(begun));
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, scene.agentId]);
    return { task, run: begun.run };
  }
  /** The run ends with its report (the worker's commit); the drain then marks the task Done or hands it back. */
  const complete = (runId: string, answer: string) => pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = $2,
    cost_state = 'released', charged_micros = 0 WHERE id = $1`, [runId, answer]);

  before(async () => {
    scene = await assistantScene('rep');
    await scene.runs.readAgentChat(human(scene.owner), scene.agentId);
  });

  test('Do it and tell me: the drain marks the task Done and the chat gets one Done line, with the agent\'s words and the task, and nothing to undo', async () => {
    await scene.setMayDo('act');
    const { task, run } = await started('Check the lamp wiring');
    await complete(run.id, 'I compared the readings: the wiring is sound.');
    const line = await reportOf(run.id);
    assert.equal(line.body, `Done: #${task.number} Check the lamp wiring`);
    assert.equal(line.words, 'I compared the readings: the wiring is sound.');
    assert.deepEqual(line.task, { id: task.id, number: task.number, title: 'Check the lamp wiring', projectId: scene.place.id, projectName: line.task!.projectName });
    // The run's only change is the agent's own reply in the task's thread, which is deleted at the line and is not part of an Undo.
    assert.deepEqual([line.changes, line.undone], [0, 0], 'no "1 change" and no Undo for a run that changed nothing');
    assert.equal((await scene.taskRow(task.id)).status, 'done');
    assert.equal(await unread(), 1);
    // One line only, and nothing in the Inbox.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await chat()).filter((item) => item.runId === run.id).length, 1);
    const inbox = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND (title ILIKE '%Done:%' OR body ILIKE '%Done:%' OR url LIKE $2)`, [scene.owner.id, `%${run.id}%`]);
    assert.equal(inbox.rowCount, 0);
    await scene.runs.readAgentChat(human(scene.owner), scene.agentId);
    assert.equal(await unread(), 0);
  });

  test('Ask me first: the task is handed back, so the line says Back to you to check, not Done', async () => {
    await scene.setMayDo('ask');
    try {
      const { task, run } = await started('Re-check the south barrel wiring');
      await complete(run.id, 'The south barrel wiring looks loose; please check it.');
      const line = await reportOf(run.id);
      assert.equal(line.body, `Back to you to check: #${task.number} Re-check the south barrel wiring`);
      assert.equal((await scene.taskRow(task.id)).status !== 'done', true);
    } finally { await scene.setMayDo('act'); }
  });

  test('the line carries the changes that stand now, only those an Undo takes back, and they stand only until they are undone', async () => {
    await scene.setMayDo('act');
    const task = await scene.task(scene.owner, 'Tidy the sensor tasks');
    // The run works through the same tools as an owner's request: it makes one child task. (The scene's live run is an owner's request; it
    // becomes this task's run, held by the agent.)
    const live = await scene.liveRun();
    await pool.query(`UPDATE personal_runs SET kind = 'task', work_id = $2, agent_id = $3 WHERE id = $1`, [live.runId, task.id, scene.agentId]);
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, scene.agentId]);
    const made = JSON.parse(text((await live.call('flux_create_task', { task: { title: 'Replace the corroded probe', parentTaskId: task.id } })).message)) as { workId: string };
    assert.ok(made.workId);
    await scene.complete(live.runId);
    const line = await reportOf(live.runId);
    assert.equal(line.body, `Done: #${task.number} Tidy the sensor tasks`);
    assert.deepEqual([line.changes, line.undone], [1, 0], 'the created task is the one change; the agent\'s own thread line does not count');
    const undone = expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(live.runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
    assert.equal(undone.undone, 1, 'Undo took back exactly what the line counted');
    const after = (await chat()).find((item) => item.runId === live.runId) as AgentChatMessage;
    assert.deepEqual([after.changes, after.undone], [0, 1], 'nothing left to undo, and the line can say it was undone');
  });

  test('a person\'s stop reports who stopped it; the system giving up, and a run that is not on a task, report nothing', async () => {
    const { task, run } = await started('Compare the last readings');
    await scene.runs.stop(human(scene.owner), run.id);
    assert.equal((await chat()).find((item) => item.runId === run.id)?.body, `Stopped by you: #${task.number} Compare the last readings`);
    // The space's admin stops it from the task: the report names that person.
    const other = await started('Compare the weekly readings');
    await personalRunWorkerUnitOfWork(db).run((ports) => stopRunBy(ports, other.run.id, scene.lead.id));
    const leadName = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [scene.lead.id])).rows[0].name as string;
    assert.equal((await chat()).find((item) => item.runId === other.run.id)?.body, `Stopped by ${leadName}: #${other.task.number} Compare the weekly readings`);
    // The system stopping a run (the task was taken away, the agent gave up) is recorded for the owner but is not their Stop: no "Stopped by you".
    const system = await started('Compare the monthly readings');
    await personalRunWorkerUnitOfWork(db).run((ports) => stopRunBy(ports, system.run.id, scene.owner.id, { system: true }));
    assert.equal((await chat()).find((item) => item.runId === system.run.id), undefined);
    // A run that is not on a task is not reported.
    const before = (await chat()).length;
    const asked = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Hello' });
    scene.compute.respond = async () => ({ kind: 'completed', text: 'Hi', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } });
    assert.equal(await scene.processor.process(asked.run.id), 'completed');
    assert.equal((await chat()).length, before);
  });
});
