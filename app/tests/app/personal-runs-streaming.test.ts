import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { REDACTED_SECRET, type PersonalRunHooks, type Principal } from '@flux/core';
import { assistantRunPath, assistantRunStopPath, type AssistantRun, type Conversation, type Project, type StreamRunText, type Workspace } from '@flux/contracts';
import { runLiveText } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { StreamClient } from './support/stream.js';
import { waitFor } from './support/wait.js';

// An agent's answer appears as it is written (#1248, AG-4): the agent runs in pi in the agent runtime (#1441, RT-1), which batches the words pi
// streams into text frames; the worker sends the asker the words about every 150 ms over the live stream (`run_text`, a NOTIFY the API hands
// to the owner's connections only), and the stored answer is still the final text, cleaned at the end. Stop keeps the words so far, marked
// stopped. pi runs for real (support/pi-runtime.ts); its model is a script, and the fake gateway answers in one text delta, so each answer
// reaches the stream as one batch. No provider pass is claimed.

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const hooks: PersonalRunHooks = {};
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

/** What a client shows of one run from its `run_text` pieces: its latest turn, each piece cutting the text at `at`. */
function shown(messages: readonly { type: string }[], runId: string) {
  let turn = 0;
  let text = '';
  const pieces = messages.filter((message): message is Extract<StreamRunText, { at: number }> => message.type === 'run_text' && (message as StreamRunText).runId === runId && 'at' in message);
  for (const piece of pieces) {
    if (piece.turn > turn) { turn = piece.turn; text = ''; }
    assert.ok(piece.at <= text.length, 'no piece is missed on an open stream');
    text = text.slice(0, piece.at) + piece.text;
  }
  return { text, pieces: pieces.length };
}

/** The Flux tools a client was told a run used, in order. */
const stepsOf = (client: StreamClient, runId: string) => client.messages.flatMap((message) => (message.type === 'run_text' && message.runId === runId && 'step' in message ? [message.step] : []));

describe('an answer appears as it is written (#1248)', () => {
  let ada: Person; let hubert: Person; let kai: Person;
  let ws: Workspace; let lamp: Project; let thread: Conversation;
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;
  const connection = randomUUID();

  before(async () => {
    [ada, hubert, kai] = await Promise.all(['str-ada', 'str-hubert', 'str-kai'].map(person));
    ws = expectStatus(await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Streaming lamp' } }), 201) as Workspace;
    for (const member of [hubert, kai]) await addMember(ada, ws.id, member, 'member');
    lamp = await createProject(ada, ws.id, 'Lamp sensor', 'restricted');
    for (const member of [hubert, kai]) await grant(ada, lamp.id, member, 'contributor');
    thread = expectStatus(await kai.browser.request('POST', `/api/v1/projects/${lamp.id}/conversations`, { body: { body: 'Camera fails below 5 lux', clientMessageId: randomUUID() } }), 201) as Conversation;
    const agent = expectStatus(await hubert.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Assistant', owner: 'self' } }), 201) as { id: string };
    connections.connect(hubert.id, connection);
    await runs.enable(human(hubert), { agentId: agent.id, connection, model: 'claude-sonnet-5' });
    pi = await startPiRuntime();
    processor = pi.processor(connections, { hooks, live: runLiveText(db) });
    await pi.place(hubert.id);
  });
  after(async () => { await pi.close(); });

  const ask = (prompt = 'Summarise this') => runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const read = async (runId: string) => expectStatus(await hubert.browser.request('GET', assistantRunPath(runId)), 200) as AssistantRun;
  /** pi reads the thread the way the brief tells it to, then writes its answer. */
  const readThenAnswer = (text: string) => pi.gateway.script([{ tool: 'mcp__flux__flux_get_conversation', args: { projectId: lamp.id, id: thread.id } }, { text }]);
  const work = (runId: string) => processor.process(runId);

  test('the words reach the asker\'s stream and nobody else\'s; the stored answer is the cleaned whole', async () => {
    const [mine, otherTab, theirs, owner] = await Promise.all([hubert, hubert, kai, ada].map((someone) => StreamClient.connect(someone.browser)));
    await Promise.all([mine, otherTab, theirs, owner].map((client) => client.ready()));
    const mark = `[message:${thread.messages[0]!.id}]`;
    readThenAnswer(`Fact: the camera fails below 5 lux ${mark}. Its key is sk-ant-api03-SECRETSECRET1234 and it should not show. More words follow here.`);
    const started = await ask();
    assert.equal(await work(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    await mine.until(() => shown(mine.messages, started.run.id).text.endsWith('follow '), 8000, 'the last complete words');

    // The words arrive in a batch of the asker's stream: a word shows only once it is complete, with the secret removed; the Flux tool pi used shows as the step.
    const view = shown(mine.messages, started.run.id);
    assert.ok(view.pieces >= 1, 'the answer arrived as a piece of the stream');
    assert.equal(view.text, `Fact: the camera fails below 5 lux ${mark}. Its key is ${REDACTED_SECRET} and it should not show. More words follow `);
    assert.equal(mine.messages.some((message) => JSON.stringify(message).includes('SECRETSECRET1234')), false, 'no piece ever carried the secret');
    assert.deepEqual(stepsOf(mine, started.run.id), ['flux_get_conversation'], 'the asker is told the Flux tool pi uses now');
    assert.equal(shown(otherTab.messages, started.run.id).text, view.text, 'every open tab of the asker sees it');

    // Nobody else: not a person of the space, not the company's owner.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const other of [theirs, owner]) assert.equal(other.messages.some((message) => message.type === 'run_text'), false, 'only the asker gets the words');

    // The stored answer is the final text, cleaned at the end: the mark numbered, the secret removed.
    const run = await read(started.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.answer?.body, `Fact: the camera fails below 5 lux [1]. Its key is ${REDACTED_SECRET} and it should not show. More words follow here.`);
    assert.equal(run.answer?.sources.length, 1);
    await Promise.all([mine, otherTab, theirs, owner].map((client) => client.close()));
  });

  test('Stop while pi works posts nothing: a stop before any words keeps nothing', async () => {
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 30' } }, { text: 'Too late.' }]);
    const early = await ask('Another question');
    const working = work(early.run.id);
    await waitFor(async () => pi.gateway.requests.length > 0, 'pi\'s first model request', 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedAt = Date.now();
    expectStatus(await hubert.browser.request('POST', assistantRunStopPath(early.run.id)), 200);
    assert.equal(await working, 'stopped', JSON.stringify(pi.lastPi()));
    assert.ok(Date.now() - stoppedAt < 10_000, 'pi was stopped, not waited for');
    assert.equal((await read(early.run.id)).answer, null);
    assert.equal(pi.gateway.requests.length, 1, 'no further model request');
  });

  test('a Stop that lands as the answer completes keeps the words that were written, marked stopped; a schedule block and what follows it do not stay', async () => {
    // Whole: the stop arrives after pi ended and before the commit, so the answer was written in full.
    readThenAnswer('All of it was written. ');
    const whole = await ask('One more');
    hooks.afterDispatch = async () => { expectStatus(await hubert.browser.request('POST', assistantRunStopPath(whole.run.id)), 200); };
    try {
      assert.equal(await work(whole.run.id), 'stopped', JSON.stringify(pi.lastPi()));
    } finally { hooks.afterDispatch = undefined; }
    const stoppedWhole = await read(whole.run.id);
    assert.equal(stoppedWhole.status, 'stopped');
    assert.equal(stoppedWhole.answer?.body, 'All of it was written.');

    // A schedule block, whole or begun, and what follows it, are left out of what a stopped run keeps: it prepares and asks nothing.
    readThenAnswer('The camera fails below 5 lux, the ToF sensor works. <schedule>{"every":"day"}</schedule> More after it.');
    const scheduled = await ask('And every day?');
    hooks.afterDispatch = async () => { expectStatus(await hubert.browser.request('POST', assistantRunStopPath(scheduled.run.id)), 200); };
    try {
      assert.equal(await work(scheduled.run.id), 'stopped', JSON.stringify(pi.lastPi()));
    } finally { hooks.afterDispatch = undefined; }
    const stoppedScheduled = await read(scheduled.run.id);
    assert.equal(stoppedScheduled.status, 'stopped');
    assert.equal(stoppedScheduled.answer?.body, 'The camera fails below 5 lux, the ToF sensor works.', 'what was written stays, cleaned the same way');
    assert.equal(stoppedScheduled.answer?.body.includes('<schedule'), false);
  });

  test('access lost while it works: no words reach the asker after it, and nothing is stored, with Stop or without', async () => {
    const mine = await StreamClient.connect(hubert.browser);
    await mine.ready();
    const runText = (runId: string) => mine.messages.filter((message) => message.type === 'run_text' && (message as StreamRunText).runId === runId && 'at' in message).length;
    const stored = async (runId: string) => (await pool.query('SELECT status, answer_body FROM personal_runs WHERE id = $1', [runId])).rows[0] as { status: string; answer_body: string | null };

    // Removed from the space as pi ends, then Stop in the tab still open: the refusal wins, the words are not kept.
    readThenAnswer('The camera fails below 5 lux, the ToF sensor works.');
    const stopped = await ask('Removed, then stopped');
    hooks.afterDispatch = async () => {
      await removeFromSpace(ada, lamp.id, hubert);
      expectStatus(await hubert.browser.request('POST', assistantRunStopPath(stopped.run.id)), 200);
    };
    try {
      await work(stopped.run.id);
    } finally { hooks.afterDispatch = undefined; await grant(ada, lamp.id, hubert, 'contributor'); }
    const ended = await stored(stopped.run.id);
    assert.equal(ended.answer_body, null, `nothing is stored (${ended.status})`);
    assert.ok(['stopped', 'denied'].includes(ended.status), ended.status);

    // Removed while pi works, with no Stop: within about a second pi is stopped and the run ends denied.
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 30' } }, { text: 'Never posted.' }]);
    const lost = await ask('Removed while it works');
    const working = work(lost.run.id);
    await waitFor(async () => pi.gateway.requests.length > 0, 'pi\'s first model request', 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const removedAt = Date.now();
    await removeFromSpace(ada, lamp.id, hubert);
    try {
      assert.equal(await working, 'denied', JSON.stringify(pi.lastPi()));
      assert.ok(Date.now() - removedAt < 10_000, 'pi, held for thirty seconds, was cut off soon after the access went');
      const afterEnd = runText(lost.run.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(runText(lost.run.id), afterEnd, 'nothing more arrives after the run ended');
      assert.equal((await stored(lost.run.id)).answer_body, null);
      assert.equal(pi.gateway.requests.length, 1, 'no model request after the access went');
    } finally {
      await grant(ada, lamp.id, hubert, 'contributor');
      await mine.close();
    }
  });
});
