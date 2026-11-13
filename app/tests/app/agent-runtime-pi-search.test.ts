import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assistantRunTools, RUN_TOKEN_LIMITS, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { MODEL_GATEWAY_LIMITS } from '@flux/runtime-protocol';
import {
  createModelGateway, createPersonalRunProcessor, KEY_SEARCH_LIMITS, KEY_SEARCH_SYSTEM, keySearchHoldMicros, runReservationMicros, type AgentRuntimeConfig, type PersonalCompute, type PersonalComputeRequest, type PersonalComputeResult, type Principal,
} from '@flux/core';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { db, pool } from './support/db.js';
import { startFakeGateway, type FakeGateway } from './support/fake-gateway.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FAKE_PRICE, FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// #1441 (RT-5): pi has no web search of its own, so an API-key agent in pi searches with Flux's `flux_web_search`: the Flux server runs it
// with the owner's key through the provider's hosted search, holds the key's budget before it and charges the run after it, and records
// the search like a CLI's (C-30). End to end with the REAL pinned pi, the real worker, manager and supervisor, an API in this process
// whose provider is a stand-in (it records each search request and answers with a search's structured results), and a fake model gateway.

const SECRET = slotSecret();
const queue = new FakeQueue();
const workerCompute = new FakeCompute();
const connections = new FakeConnections();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

/** The provider behind the API's search: one search, with what Anthropic's hosted search returns in its structured blocks. */
class SearchProvider implements PersonalCompute {
  enabled = true;
  requests: PersonalComputeRequest[] = [];
  async dispatch(request: PersonalComputeRequest): Promise<PersonalComputeResult> {
    this.requests.push(request);
    return { kind: 'completed', stopReason: 'end_turn', text: 'Flux runtime guide — https://docs.example.org/runtime — how agents run.',
      usage: { inputTokens: 2_000, outputTokens: 200, webSearches: 1 },
      webSearch: { queries: ['flux agent runtime'], results: ['https://docs.example.org/runtime', 'https://blog.example.org/pi'], cited: [] } };
  }
}

describe('an API-key agent in pi searches the web with Flux\'s flux_web_search (#1441)', () => {
  let slot: TestSlot; let manager: ReturnType<typeof createManagerServer>; let config: AgentRuntimeConfig; let gateway: FakeGateway;
  let owner: Person; let ws: Workspace; let place: Project; let thread: Conversation; let connectionId: string;
  let runs: ReturnType<typeof personalRunUseCases>; let processor: ReturnType<typeof createPersonalRunProcessor>;
  let base = ''; let closeApp: () => Promise<void> = async () => undefined;
  const provider = new SearchProvider();

  const ask = (prompt = 'What is new in the agent runtime?') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const row = async (runId: string) => (await pool.query('SELECT status, end_reason, answer_body, cost_state, charged_micros FROM personal_runs WHERE id = $1', [runId])).rows[0] as Record<string, unknown>;

  before(async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_WEB_READS: 'on', FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `pi-search-${'x'.repeat(40)}`,
      FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'), 'packages/db/migrations', { keySearcher: { compute: provider, connections } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    closeApp = () => app.close();
    gateway = await startFakeGateway();
    slot = await startTestSlot({ slot: `runtime-8${Math.floor(Math.random() * 90 + 10)}`, enabled: [], mcpUrl: `${base}/mcp`, ownTools: true, pi: { modelOrigin: gateway.url } });
    manager = createManagerServer({ secret: SECRET, slots: new Map([[slot.config.slot, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }]]), log: () => undefined });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    config = { clients: [], keys: true, commercialTermsAgreedOn: null, idleDays: null, manager: { url: `http://127.0.0.1:${(manager.address() as AddressInfo).port}`, secret: SECRET } };
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'ready') ON CONFLICT (slot) DO UPDATE SET state = 'ready'`, [slot.config.slot]);
    owner = await person('rt-pi-search');
    ws = await createWorkspace(owner, 'Pi search');
    place = await createProject(owner, ws.id, 'Research', 'workspace');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'What changed in the runtime?', clientMessageId: randomUUID() } }), 201) as Conversation;
    // The owner's place is made on this file's own runtime (others' runtimes may be in this database).
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'binding')`, [randomUUID(), owner.id, slot.config.slot]);
    runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, runtime: personalRuntimeAvailability(config, db) });
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute: workerCompute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, base), stopPollMs: 50,
      gateway: createModelGateway({ uow: personalRunWorkerUnitOfWork(db), connections, limits: MODEL_GATEWAY_LIMITS, tokenLifetimeMs: RUN_TOKEN_LIMITS.lifetimeSeconds * 1000 }), runtimeCaps: { idleSeconds: 20, wallClockSeconds: 60, maxTurns: 10 } });
    connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
  });
  after(async () => {
    await pool.query(`UPDATE agent_runtime_slots SET state = 'out_of_pool', out_of_pool_reason = 'missing' WHERE slot = $1`, [slot.config.slot]).catch(() => undefined);
    await new Promise<void>((done) => manager.close(() => done()));
    await slot.close();
    await gateway.close();
    await closeApp();
  });
  beforeEach(async () => {
    provider.requests = [];
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('pi is offered flux_web_search; the server searches with the run\'s key and model, records the search and charges the run', async () => {
    gateway.script([{ tool: 'mcp__flux__flux_web_search', args: { query: 'flux agent runtime' } }, { text: 'See the runtime guide at https://docs.example.org/runtime.' }]);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(await row(started.run.id)));
    assert.ok(gateway.requests[0]!.tools.includes('mcp__flux__flux_web_search'), JSON.stringify(gateway.requests[0]!.tools));
    assert.match(gateway.requests[0]!.prompt, /search the web with flux_web_search/, 'the brief names the tool');
    const [search] = provider.requests;
    assert.ok(search, 'the server ran one search');
    assert.deepEqual([search.connection.id, search.model, search.webSearch, search.webSearchMaxUses, search.tools], [connectionId, 'claude-sonnet-5', true, KEY_SEARCH_LIMITS.searches, undefined],
      'the run\'s own key and model, the hosted search alone, bounded to a few searches');
    assert.equal(search.system, KEY_SEARCH_SYSTEM);
    assert.match(search.input, /flux agent runtime/);
    assert.match(gateway.requests[1]!.results[0] ?? '', /docs\.example\.org\/runtime/, 'pi got the results');
    const recorded = (await pool.query('SELECT queries, results FROM personal_run_web_searches WHERE run_id = $1', [started.run.id])).rows;
    assert.deepEqual(recorded.map((entry) => entry.queries), [['flux agent runtime']]);
    assert.ok((recorded[0].results as string[]).includes('https://docs.example.org/runtime'));
    const stored = await row(started.run.id);
    assert.equal(stored.cost_state, 'observed');
    assert.ok(Number(stored.charged_micros) > 0, 'the search is charged on the run');
    assert.match(String(stored.answer_body), /docs\.example\.org\/runtime/);
  });

  test('a search that does not fit the key\'s budget is refused before anything is sent', async () => {
    // A day's budget that holds the run's own requests but not a search's larger one (its results are input too).
    const request = runReservationMicros(FAKE_PRICE, true, false)!; const search = keySearchHoldMicros(FAKE_PRICE)!;
    assert.ok(search > request + 20_000, `${search} > ${request}`);
    connections.connect(owner.id, connectionId, { dailyBudgetCents: Math.floor((request + search) / 2 / 10_000) });
    try {
      gateway.script([{ tool: 'mcp__flux__flux_web_search', args: { query: 'anything' } }, { text: 'No search.' }]);
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'completed');
      assert.equal(provider.requests.length, 0, 'nothing reached the provider');
      assert.match(gateway.requests[1]!.results[0] ?? '', /budget/i);
    } finally { connections.connect(owner.id, connectionId); }
  });

  test('with the web off the run is not given it, so its brief never names a search it does not have (#1452 review)', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_WEB_READS: 'off', FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `pi-search-${'x'.repeat(40)}`,
      FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const off = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'), 'packages/db/migrations', { keySearcher: { compute: provider, connections } });
    await off.listen({ port: 0, host: '127.0.0.1' });
    try {
      const offBase = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
      const issue = async (url: string) => {
        const started = await ask('Anything new?');
        await pool.query(`UPDATE personal_runs SET status = 'dispatching', dispatched_at = now() WHERE id = $1`, [started.run.id]);
        const grant = await runTokenIssuer(db, url).issue(started.run.id, { pi: true });
        await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released' WHERE id = $1`, [started.run.id]);
        return grant?.tools ?? null;
      };
      const on = await issue(base);
      assert.ok(on?.includes('flux_web_search'), JSON.stringify(on));
      const without = await issue(offBase);
      assert.ok(without && without.length > 0 && !without.includes('flux_web_search'), JSON.stringify(without));
    } finally { await off.close(); }
  });

  test('only a key run in pi gets it: a run in the worker\'s own loop and a plan CLI\'s never list it', () => {
    for (const readOnly of [true, false]) assert.ok(!assistantRunTools(readOnly).includes('flux_web_search'));
  });
});
