import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createPersonalRunProcessor, REDACTED_SECRET, type PersonalComputeRequest, type PersonalComputeResult, type Principal } from '@flux/core';
import { assistantRunPath, assistantRunStopPath, type AssistantRun, type Conversation, type Project, type StreamRunText, type Workspace } from '@flux/contracts';
import { runLiveText } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { StreamClient } from './support/stream.js';

// An agent's answer appears as it is written (#1248, AG-4): the provider streams, the worker sends the asker the words about every 150 ms
// over the live stream (`run_text`, a NOTIFY the API hands to the owner's connections only), and the stored answer is still the final text,
// cleaned at the end. Stop while it writes keeps the words so far, marked stopped. A streaming fake provider: no provider pass is claimed.

/** A provider that streams its answer in pieces, `gapMs` apart, and stops when the request is aborted. */
class StreamingCompute extends FakeCompute {
  pieces: string[] = [];
  gapMs = 60;
  /** The pieces it sent before it ended. */
  sent: string[] = [];
  /** Endless: it keeps writing until it is stopped. */
  endless = false;

  override async dispatch(request: PersonalComputeRequest, signal: AbortSignal, onText?: (delta: string) => void): Promise<PersonalComputeResult> {
    this.dispatched.push(request);
    this.sent = [];
    for (let index = 0; this.endless || index < this.pieces.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.gapMs));
      if (signal.aborted) return { kind: 'failed', reason: 'aborted', billed: 'unknown' };
      const piece = this.pieces[index % this.pieces.length]!;
      this.sent.push(piece);
      onText?.(piece);
    }
    return { kind: 'completed', stopReason: 'end_turn', text: this.sent.join(''), usage: { inputTokens: Math.ceil(request.input.length / 4), outputTokens: 60 } };
  }
}

const connections = new FakeConnections();
const compute = new StreamingCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20, live: runLiveText(db) });
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

describe('an answer appears as it is written (#1248)', () => {
  let ada: Person; let hubert: Person; let kai: Person;
  let ws: Workspace; let lamp: Project; let thread: Conversation;
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
  });

  const ask = (prompt = 'Summarise this') => runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const read = async (runId: string) => expectStatus(await hubert.browser.request('GET', assistantRunPath(runId)), 200) as AssistantRun;

  test('the words reach the asker\'s stream in pieces and nobody else\'s; the stored answer is the cleaned whole', async () => {
    const [mine, otherTab, theirs, owner] = await Promise.all([hubert, hubert, kai, ada].map((someone) => StreamClient.connect(someone.browser)));
    await Promise.all([mine, otherTab, theirs, owner].map((client) => client.ready()));
    compute.endless = false;
    compute.pieces = ['Fact: the camera ', 'fails below 5 lux [S1]. ', 'Its key is sk-ant-api03-', 'SECRETSECRET1234 and ', 'it should not show. ', 'More words ', 'follow here.'];
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    await mine.until(() => shown(mine.messages, started.run.id).text.endsWith('follow '), 5000, 'the last complete words');

    // Several pieces, each a batch of about 150 ms: the words grew, and a word shows only once it is complete, with the secret removed.
    const view = shown(mine.messages, started.run.id);
    assert.ok(view.pieces >= 2, `the answer arrived in pieces (${view.pieces})`);
    assert.ok(view.pieces < compute.pieces.length + 2, 'pieces are batched, not one per token');
    assert.equal(view.text, `Fact: the camera fails below 5 lux [S1]. Its key is ${REDACTED_SECRET} and it should not show. More words follow `);
    assert.equal(mine.messages.some((message) => JSON.stringify(message).includes('SECRETSECRET1234')), false, 'no piece ever carried the secret');
    assert.equal(shown(otherTab.messages, started.run.id).text, view.text, 'every open tab of the asker sees it');

    // Nobody else: not a person of the space, not the company's owner.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const other of [theirs, owner]) assert.equal(other.messages.some((message) => message.type === 'run_text'), false, 'only the asker gets the words');

    // The stored answer is the final text, cleaned at the end: the source mark numbered, the secret removed.
    const run = await read(started.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.answer?.body, `Fact: the camera fails below 5 lux [1]. Its key is ${REDACTED_SECRET} and it should not show. More words follow here.`);
    assert.equal(run.answer?.sources.length, 1);
    await Promise.all([mine, otherTab, theirs, owner].map((client) => client.close()));
  });

  test('Stop while it writes keeps the words so far as the answer, marked stopped; a stop before any words posts nothing', async () => {
    const mine = await StreamClient.connect(hubert.browser);
    await mine.ready();
    compute.endless = true;
    compute.gapMs = 80;
    compute.pieces = ['The camera fails ', 'below 5 lux, ', 'the ToF sensor works. ', '<schedule>{"every":"day"}', '</schedule> '];
    const started = await ask();
    const working = processor.process(started.run.id);
    await mine.until(() => shown(mine.messages, started.run.id).text.includes('below 5 lux'), 5000, 'the first words');
    expectStatus(await hubert.browser.request('POST', assistantRunStopPath(started.run.id)), 200);
    assert.equal(await working, 'stopped');
    const run = await read(started.run.id);
    assert.equal(run.status, 'stopped');
    const written = compute.sent.join('');
    const kept = written.slice(0, written.search(/<schedule\b/) >= 0 ? written.search(/<schedule\b/) : written.length).trim();
    assert.ok(kept.startsWith('The camera fails below 5 lux,'), kept);
    assert.equal(run.answer?.body, kept, 'what was written stays, cleaned the same way; a schedule block and what follows it do not');
    assert.equal(run.answer?.body.includes('<schedule'), false);

    // Stopped before any words: nothing to keep.
    compute.gapMs = 400;
    compute.pieces = ['Too late. '];
    const early = await ask('Another question');
    const waiting = processor.process(early.run.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expectStatus(await hubert.browser.request('POST', assistantRunStopPath(early.run.id)), 200);
    assert.equal(await waiting, 'stopped');
    assert.equal((await read(early.run.id)).answer, null);
    compute.endless = false;
    compute.gapMs = 60;
    await mine.close();
  });
});
