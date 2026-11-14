import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createPersonalRunProcessor, type Principal } from '@flux/core';
import type { Conversation, Project, Workspace } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, loseSpace, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { chooseModel, FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { waitFor } from './support/wait.js';

// An API-key run in the worker (F-027 AST-8.2 and AST-8.3, issue #406; #1441, RT-1): every agent runs in the agent runtime, an API key's in pi.
// pi reads the space with the Flux tools, its model requests go through Flux's model gateway (which meters each against the key's daily
// budget, #854), and the worker has no tool loop of its own: the standing checks before, during and at the end of the run, the commit
// and the cost are what this file proves. Driven through the real use cases, the real worker processor, runtime manager and supervisor with
// the REAL pinned pi (the test image's), and the real database, with a scripted stand-in for the gateway (support/fake-gateway.ts: no model,
// no provider, and it charges nothing, so a run's cost here is released). None of this is a provider, billing or compatibility pass.

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const FLUX = 'mcp__flux__';
const refusal = (status: number, error: { type: string; code?: string; message: string }) => ({ status, body: { type: 'error', error } });

async function row(runId: string) {
  const result = await pool.query(`SELECT status, end_reason, cost_state, charged_micros, reserved_micros, answer_body, answer_redacted, stopped_at_stage, committed_at IS NOT NULL AS committed,
    resume_at IS NOT NULL AS resumes, connection_id FROM personal_runs WHERE id = $1`, [runId]);
  return result.rows[0] as { status: string; end_reason: string | null; cost_state: string; charged_micros: number; reserved_micros: number; answer_body: string | null;
    answer_redacted: boolean; stopped_at_stage: string | null; committed: boolean; resumes: boolean; connection_id: string | null };
}

describe('an API-key run in the worker is pi in the agent runtime (AST-8.2, AST-8.3, #1441; scripted gateway, no provider pass)', () => {
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;
  let owner: Person; let ws: Workspace; let place: Project; let thread: Conversation;
  let agentId: string;

  /** The owner's assistant on a fresh connection (its daily budget, if given, is the only limit). */
  async function useConnection(model: Parameters<FakeConnections['connect']>[2] = {}) {
    // Deleting an agent is for good (#857): the next connection gets a new agent.
    if (await runs.remove(human(owner)).then(() => true, () => false)) agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    const connectionId = randomUUID();
    // Turned on with room for one request; the test's own budget stands for what is left of the day.
    connections.connect(owner.id, connectionId, { ...model, dailyBudgetCents: 1_000 });
    await runs.enable(human(owner), { agentId, connection: connectionId, model: model.model ?? 'claude-sonnet-5' });
    connections.connect(owner.id, connectionId, model);
  }
  const ask = (prompt = 'Tidy the open tasks') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  /** The first step of a run that reads the conversation it was asked in, as the model of a key does with its Flux tool. */
  const readThread = () => ({ tool: `${FLUX}flux_get_conversation`, args: { projectId: place.id, id: thread.id } });
  /** pi is working on its first command once the gateway has been asked for it. */
  const piHasStarted = () => waitFor(async () => pi.gateway.requests.length > 0, 'pi to ask the gateway');

  before(async () => {
    pi = await startPiRuntime();
    owner = await person('pt-owner');
    ws = await createWorkspace(owner, 'Key runs in pi');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    await pi.place(owner.id);
    processor = pi.processor(connections);
  });
  after(async () => { await pi.close(); });
  beforeEach(async () => {
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
  });

  test('a run reads the space with the Flux tools and ends in the model\'s answer: it is committed with its sources, holds nothing up front and costs what the gateway charged', async () => {
    await useConnection({});
    pi.gateway.script([readThread(), { text: `Fact: the camera fails below 5 lux [message:${thread.messages[0]!.id}].` }]);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.committed, stored.reserved_micros, stored.cost_state, stored.charged_micros], ['completed', true, 0, 'released', 0],
      'the worker holds nothing for the run; the gateway charged no request here');
    assert.match(stored.answer_body ?? '', /the camera fails below 5 lux \[1\]/, 'what its tool returned, cited, is a numbered source');
    assert.equal(pi.gateway.requests.length, 2, 'one request asked for the conversation, one gave the answer');
    assert.ok(pi.gateway.requests[0]!.tools.includes(`${FLUX}flux_get_conversation`), 'the run\'s own Flux tools');
    assert.match(pi.gateway.requests[1]!.results[0] ?? '', /Camera fails below 5 lux in the low-light test/, 'the model reads the space itself');
  });

  test('an API-key answer is redacted like a runtime answer: token-shaped strings never reach the conversation (#484)', async () => {
    await useConnection({});
    const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt';
    for (const [text, redacted] of [[`Fact: the key is ${secret} and Bearer abc.def-123.`, true], ['Fact: nothing secret here.', false]] as const) {
      pi.gateway.script([{ text }]);
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
      const stored = await row(started.run.id);
      assert.equal(stored.answer_redacted, redacted);
      assert.ok(!(stored.answer_body ?? '').includes(secret) && !(stored.answer_body ?? '').includes('abc.def-123'), 'the secret is not stored');
      if (redacted) assert.ok((stored.answer_body ?? '').includes('[removed: looked like a secret]'));
    }
  });

  test('AST-8.2: the gateway refuses for the key\'s daily budget in the middle of a run: it ends at its limit, the changes made stay and nothing is posted', async () => {
    await useConnection({});
    const title = `Replace the corroded probe ${randomUUID().slice(0, 8)}`;
    pi.gateway.script([
      { tool: `${FLUX}flux_create_task`, args: { clientCommandId: randomUUID(), task: { title } } },
      refusal(402, { type: 'flux_budget_exhausted', code: 'flux_budget_exhausted', message: 'The key\'s daily budget cannot hold this request; stop' }),
    ]);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached', JSON.stringify(pi.lastPi()));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason, stored.answer_body, stored.cost_state, stored.charged_micros], ['cap_reached', 'budget', null, 'released', 0]);
    assert.equal(pi.gateway.requests.length, 2, 'pi does not retry a refusal');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE title = $1', [title])).rows[0].n, 1, 'the call of the first turn was made and stays');
  });

  test('CA-3: the provider\'s API credits ran out: one end of its own, nothing billed, nothing switches', async () => {
    await useConnection({});
    pi.gateway.script([refusal(400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' })]);
    const started = await ask('When credits are out');
    assert.equal(await processor.process(started.run.id), 'provider_failed', JSON.stringify(pi.lastPi()));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.cost_state, stored.answer_body], ['credits', 'released', null]);
    assert.equal(pi.gateway.requests.length, 1);
  });

  test('access revoked while the run works: nothing is posted, the run ends denied at its commit and is not charged', async () => {
    await useConnection({});
    const lost: { restore?: () => Promise<void> } = {};
    // The owner no longer has the space when the run is done: their assistant loses it with them (F-036 AG-3).
    const losing = pi.processor(connections, { hooks: { afterDispatch: async () => { lost.restore = await loseSpace(place.id, owner.id); } } });
    pi.gateway.script([readThread(), { text: 'Fact: the camera fails below 5 lux.' }]);
    const started = await ask();
    try {
      assert.equal(await losing.process(started.run.id), 'denied', JSON.stringify(pi.lastPi()));
    } finally { await lost.restore?.(); }
    const stored = await row(started.run.id);
    assert.deepEqual([stored.stopped_at_stage, stored.cost_state, stored.charged_micros, stored.answer_body, stored.committed], ['before_commit', 'released', 0, null, false]);
  });

  test('Stop during a call ends the run stopped at once: pi is stopped, not waited for, and nothing is posted', async () => {
    await useConnection({});
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 30' } }, { text: 'Should not be posted.' }]);
    const started = await ask();
    const began = Date.now();
    const done = processor.process(started.run.id);
    await piHasStarted();
    await new Promise((wait) => setTimeout(wait, 500));
    await runs.stop(human(owner), started.run.id);
    assert.equal(await done, 'stopped', JSON.stringify(pi.lastPi()));
    assert.ok(Date.now() - began < 20_000, 'pi was stopped, not waited for');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.cost_state, stored.answer_body, stored.committed], ['stopped', 'released', null, false]);
    assert.equal(pi.gateway.requests.length, 1, 'no further request was made');
  });

  test('#854: choosing a model on another connection does not touch a run underway; it finishes on its own key', async () => {
    await useConnection({});
    const { connectionId } = (await pool.query('SELECT api_key_id AS "connectionId" FROM assistant_settings WHERE agent_id = $1', [agentId])).rows[0];
    const other = randomUUID();
    connections.connect(owner.id, other, {});
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 2' } }, { text: 'Fact: finished.' }]);
    const sent = await ask('Finish this');
    const done = processor.process(sent.run.id);
    await piHasStarted();
    await chooseModel(runs, human(owner), { connection: other, model: 'claude-sonnet-5' });
    assert.equal(await done, 'completed', 'the owner pays for this request, so it answers');
    assert.equal((await row(sent.run.id)).connection_id, connectionId);
  });

  test('a worker without a runtime that has pi, or with the operator\'s switch off, ends a key run unavailable at zero cost: it never becomes another run', async () => {
    await useConnection({});
    pi.gateway.script([]);
    // No runtime, no run token: the worker has no loop of its own to fall back to.
    const bare = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute: new FakeCompute(), stopPollMs: 20 });
    const none = await ask();
    assert.equal(await bare.process(none.run.id), 'unavailable');
    assert.deepEqual([(await row(none.run.id)).cost_state, (await row(none.run.id)).charged_micros], ['released', 0]);
    // The operator's one switch (`FLUX_PERSONAL_RUNS`) off, with a runtime that has pi.
    const off = pi.processor(connections, { enabled: false });
    const switchedOff = await ask();
    assert.equal(await off.process(switchedOff.run.id), 'unavailable');
    assert.deepEqual([(await row(switchedOff.run.id)).cost_state, (await row(switchedOff.run.id)).charged_micros], ['released', 0]);
    assert.equal(pi.gateway.requests.length, 0, 'no model request was made');
  });

  test('#854: a request the key\'s day cannot hold with the Flux tools waits for the key\'s next day instead of being refused, from when it is asked', async () => {
    // Not even one request fits $0.10 (32,000 × $2/M + 4,000 × $10/M = $0.104): it waits, queued, with its resume time.
    await useConnection({ dailyBudgetCents: 10 });
    const paused = await ask('Too little left');
    assert.deepEqual([paused.run.status, paused.run.endReason, !!paused.run.resumesAt], ['queued', 'budget', true]);
    await runs.stop(human(owner), paused.run.id);
    // $0.15 would hold one request without tools but not one with them (64,000 × $2/M + 4,000 × $10/M = $0.168), and every run is pi with the
    // Flux tools (#1441): it waits at once too, and its turn sends nothing.
    await useConnection({ dailyBudgetCents: 15 });
    const asked = await ask('Fits only without tools');
    assert.deepEqual([asked.run.status, asked.run.endReason, !!asked.run.resumesAt], ['queued', 'budget', true]);
    pi.gateway.script([]);
    assert.equal(await processor.process(asked.run.id), 'skipped');
    const waiting = await row(asked.run.id);
    assert.deepEqual([waiting.status, waiting.end_reason, waiting.resumes], ['queued', 'budget', true]);
    assert.equal(pi.gateway.requests.length, 0, 'nothing was sent');
    await runs.stop(human(owner), asked.run.id);
  });
});
