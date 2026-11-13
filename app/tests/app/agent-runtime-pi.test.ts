import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { agentConnectionPath, assistantChangeActionPath, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { RUN_TOKEN_LIMITS } from '@flux/contracts';
import { createModelGateway, createPersonalRunProcessor, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { MODEL_GATEWAY_LIMITS, parseModelGatewayUrl, parseRuntimeEngines, parseSupervisorRequest } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { classifyPiError, gatewayProvider, piArgs, PI_OWN_TOOLS } from '../../apps/runtime/src/supervisor/pi.js';
import { RUN_BRIEF_OWN_TOOLS } from '../../apps/runtime/src/supervisor/run.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { agentSettings } from './support/agent-settings.js';
import { db, pool } from './support/db.js';
import { startFakeGateway, type FakeGateway } from './support/fake-gateway.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// #1441 (RT-1, RT-5): with `pi` in FLUX_AGENT_RUNTIME every API-key agent runs in pi in the runtime, under the same contract as Claude Code
// and Codex. End to end with the real worker, manager, supervisor and API, the REAL pinned pi (the test image's /opt/flux-runtime/pi,
// started through the built launcher) and a fake model gateway in place of Flux's (support/fake-gateway.ts): no provider is reached. The
// sandbox here is the harness's pass-through stand-in; Landlock itself is proved in the runtime container (scripts/check_runtime_sandbox.sh).

const SECRET = slotSecret();
const queue = new FakeQueue();
const compute = new FakeCompute();
const connections = new FakeConnections();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

describe('API-key agents run in pi in the runtime (#1441)', () => {
  let slot: TestSlot; let manager: ReturnType<typeof createManagerServer>; let config: AgentRuntimeConfig; let gateway: FakeGateway;
  let owner: Person; let ws: Workspace; let place: Project; let thread: Conversation;
  let runs: ReturnType<typeof personalRunUseCases>;
  /** What pi printed in the last run, shown when a run does not end as a test expects. */
  let lastPi: { stderr: string; mcpLog: string; events: string[] } | null = null;
  const why = async (runId: string) => JSON.stringify({ row: await row(runId), requests: gateway.requests.map((request) => ({ path: request.path, tools: request.tools })), pi: lastPi }, null, 1).slice(0, 20_000);
  let processor: ReturnType<typeof createPersonalRunProcessor>;
  let apiUrl = ''; let closeApp: () => Promise<void> = async () => undefined;

  const ask = (prompt = 'Make a page of the notes') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const row = async (runId: string) => (await pool.query('SELECT status, end_reason, answer_body, cost_state, engine FROM personal_runs WHERE id = $1', [runId])).rows[0] as Record<string, unknown>;
  const scratchRoot = () => slot.config.sandbox!.scratchRoot;

  before(async () => {
    gateway = await startFakeGateway();
    // The manager first, then an API of this file's own that reaches it (flux_attach_file reads a run's scratch through it, #1437), then
    // the slot, whose pi reaches that API's MCP route.
    const slots = new Map<string, { host: string; port: number; secret: string }>();
    manager = createManagerServer({ secret: SECRET, slots, log: () => undefined });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    const managerUrl = `http://127.0.0.1:${(manager.address() as AddressInfo).port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_AGENT_RUNTIME: 'pi', FLUX_RUNTIME_MANAGER_URL: managerUrl, FLUX_RUNTIME_MANAGER_SECRET: SECRET,
      FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `pi-runs-${'x'.repeat(40)}`, FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'), 'packages/db/migrations');
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    closeApp = () => app.close();
    slot = await startTestSlot({ slot: `runtime-7${Math.floor(Math.random() * 90 + 10)}`, enabled: [], mcpUrl: `${apiUrl}/mcp`, ownTools: true,
      pi: { modelOrigin: gateway.url, diagnostics: (what) => { lastPi = what; } } });
    slots.set(slot.config.slot, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
    config = { clients: [], keys: true, commercialTermsAgreedOn: null, idleDays: null, manager: { url: managerUrl, secret: SECRET } };
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'ready') ON CONFLICT (slot) DO UPDATE SET state = 'ready'`, [slot.config.slot]);
    // Other files leave runtimes of their own in this database: the owner's place is made on this one (pi needs no sign-in, only the place).
    owner = await person('rt-pi');
    ws = await createWorkspace(owner, 'Pi runs');
    place = await createProject(owner, ws.id, 'Reports', 'workspace');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Please turn the notes into a page', clientMessageId: randomUUID() } }), 201) as Conversation;
    const bindingId = randomUUID();
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'binding')`, [bindingId, owner.id, slot.config.slot]);
    runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, runtime: personalRuntimeAvailability(config, db) });
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50,
      gateway: createModelGateway({ uow: personalRunWorkerUnitOfWork(db), connections, limits: MODEL_GATEWAY_LIMITS, tokenLifetimeMs: RUN_TOKEN_LIMITS.lifetimeSeconds * 1000 }), runtimeCaps: { idleSeconds: 20, wallClockSeconds: 60, maxTurns: 10 } });
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
  });
  after(async () => {
    // The runtime this file made is gone with it: later files count the runtimes' room (#860).
    await pool.query(`UPDATE agent_runtime_slots SET state = 'out_of_pool', out_of_pool_reason = 'missing' WHERE slot = $1`, [slot.config.slot]).catch(() => undefined);
    await new Promise<void>((done) => manager.close(() => done()));
    await slot.close();
    await gateway.close();
    await closeApp();
  });
  beforeEach(async () => {
    compute.dispatched = [];
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('a full run: pi gets exactly the run\'s Flux tools and its own four, works in an empty scratch, reaches the gateway with the run token only, and the answer comes back like a plan run\'s', async () => {
    gateway.script([
      { tool: 'bash', args: { command: 'pwd; ls -A | wc -l; printf "<h1>Notes</h1>" > notes.html; ls' } },
      { tool: 'mcp__flux__flux_list_contexts', args: {} },
      { text: 'Done: I made notes.html.' },
    ]);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed', await why(started.run.id));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason, stored.engine], ['completed', null, 'server'], 'an API-key run, run in pi');
    assert.match(String(stored.answer_body), /Done: I made notes\.html\./);
    assert.equal(compute.dispatched.length, 0, 'the worker\'s own loop was not used');
    assert.equal(gateway.requests.length, 3);
    const [first] = gateway.requests;
    assert.equal(first!.path, '/anthropic/v1/messages', 'the Anthropic key speaks Messages to the gateway, at its Anthropic base URL');
    assert.equal(first!.model, 'claude-sonnet-5');
    assert.match(first!.apiKey ?? '', /^flux_mg_[\w-]{43}$/, 'the credential is the run\'s gateway token, in Anthropic\'s own header');
    assert.ok(!gateway.requests.some((request) => /test-key-ref|sk-|\.ey/.test(`${request.authorization} ${request.apiKey}`)), 'never a key or the MCP run token');
    assert.ok((await pool.query('SELECT gateway_token_hash FROM personal_runs WHERE id = $1', [started.run.id])).rows[0].gateway_token_hash === null, 'closed at the end');
    const fluxTools = first!.tools.filter((tool) => tool.startsWith('mcp__flux__'));
    assert.deepEqual(first!.tools.filter((tool) => !tool.startsWith('mcp__flux__')).sort(), [...PI_OWN_TOOLS].sort(), 'pi\'s own tools: read, bash, edit, write; nothing else');
    assert.ok(fluxTools.includes('mcp__flux__flux_list_contexts') && fluxTools.length > 3, JSON.stringify(fluxTools));
    assert.ok(first!.system.includes(RUN_BRIEF_OWN_TOOLS), 'Flux\'s brief is appended to pi\'s own prompt');
    const shell = gateway.requests[1]!.results[0]!.split('\n');
    assert.equal(shell[0], join(scratchRoot(), started.run.id), 'the scratch is the working directory');
    assert.deepEqual(shell.slice(1, 3), ['0', 'notes.html'], 'empty at the start; the file was made there');
    assert.match(gateway.requests[2]!.results[1] ?? '', /Reports|context/i, 'the Flux tool ran through Flux\'s MCP route');
    assert.deepEqual(await readdir(scratchRoot()), [], 'the scratch is gone after the run');
    assert.equal((await readdir(join(slot.config.dataDir))).length, 1, 'the owner\'s place in the runtime was made for the run (no sign-in)');
  });

  test('the gateway\'s budget refusal ends the run at once, with one request and nothing posted', async () => {
    gateway.script([{ status: 402, body: { type: 'error', error: { type: 'flux_budget_exhausted', code: 'flux_budget_exhausted', message: 'The key\'s daily budget cannot hold this request; stop' } } }]);
    const started = await ask('Summarize the notes');
    assert.equal(await processor.process(started.run.id), 'cap_reached', await why(started.run.id));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body, stored.cost_state], ['budget', null, 'released']);
    assert.equal(gateway.requests.length, 1, 'pi does not retry a refusal');
  });

  test('pi attaches a file it made in its scratch with flux_attach_file (#1437), like its asker\'s own upload', async () => {
    gateway.script([
      { tool: 'bash', args: { command: 'printf "<h1>Notes</h1>" > notes.html' } },
      { tool: 'mcp__flux__flux_attach_file', args: { projectId: place.id, clientCommandId: randomUUID(), path: 'notes.html', name: 'notes.html' } },
      { tool: 'mcp__flux__flux_attach_file', args: { projectId: place.id, clientCommandId: randomUUID(), path: '../escape.html', name: 'escape.html' } },
      { text: 'Attached notes.html.' },
    ]);
    const started = await ask('Make me a page');
    assert.equal(await processor.process(started.run.id), 'completed', await why(started.run.id));
    // Each request carries every tool result so far: the last is the newest.
    const attached = gateway.requests[2]!.results.at(-1) ?? '';
    assert.doesNotMatch(attached, /Not attached|no working directory/i, attached);
    assert.match(attached, /notes\.html/, attached);
    assert.match(gateway.requests[3]!.results.at(-1) ?? '', /Not attached/, 'nothing outside the scratch');
    const [change] = (await pool.query(`SELECT state FROM assistant_changes WHERE run_id = $1`, [started.run.id])).rows as { state: string }[];
    assert.ok(change, 'the attachment is the run\'s change, with its line and Undo');
    assert.deepEqual(await readdir(scratchRoot()), [], 'the scratch is gone after the run');
  });

  test('the gateway\'s refusal mid-run stops pi at once (#1441 review): the run ends "budget", not when pi gives up', async () => {
    const real = createModelGateway({ uow: personalRunWorkerUnitOfWork(db), connections, limits: MODEL_GATEWAY_LIMITS, tokenLifetimeMs: RUN_TOKEN_LIMITS.lifetimeSeconds * 1000 });
    const engine: { tell?: ((reason: 'budget' | 'ended') => void) | undefined } = {};
    const watched = { issue: real.issue, close: real.close, watch: (_runId: string, listener: (reason: 'budget' | 'ended') => void) => { engine.tell = listener; return () => { engine.tell = undefined; }; } };
    const stopping = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50, gateway: watched,
      runtimeCaps: { idleSeconds: 20, wallClockSeconds: 60, maxTurns: 10 } });
    gateway.script([{ tool: 'bash', args: { command: 'sleep 30' } }, { text: 'Should not be posted.' }]);
    const started = await ask('Work a long time');
    const began = Date.now();
    const done = stopping.process(started.run.id);
    while (!gateway.requests.length && Date.now() - began < 20_000) await new Promise((wait) => setTimeout(wait, 50));
    // The gateway refused the run's next request for the key's day (402): it tells the engine.
    await new Promise((wait) => setTimeout(wait, 300));
    assert.ok(engine.tell, 'the engine watches its run at the gateway');
    engine.tell('budget');
    assert.equal(await done, 'cap_reached', await why(started.run.id));
    assert.ok(Date.now() - began < 20_000, 'pi was stopped, not waited for');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body], ['budget', null]);
  });

  test('"Ask me first" makes a change wait in Flux\'s MCP route, exactly as for a plan CLI', async () => {
    const settings = await agentSettings(owner, ws.id);
    expectStatus(await owner.browser.request('PATCH', agentConnectionPath(settings.connectionId), { body: { mayDo: 'ask' } }), 200);
    try {
      gateway.script([
        { tool: 'mcp__flux__flux_create_task', args: { clientCommandId: randomUUID(), task: { title: 'Pi waits for the owner' } } },
        { text: 'Asked first.' },
      ]);
      const started = await ask('Add a task');
      assert.equal(await processor.process(started.run.id), 'completed', await why(started.run.id));
      assert.match(gateway.requests[1]!.results[0] ?? '', /^Waiting for .+'s OK: add task Pi waits for the owner\.$/);
      const [waiting] = (await pool.query(`SELECT id, state, wait_reason, version FROM assistant_changes WHERE run_id = $1`, [started.run.id])).rows as { id: string; state: string; wait_reason: string; version: number }[];
      assert.deepEqual([waiting!.state, waiting!.wait_reason], ['waiting', 'ask']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Pi waits for the owner'`)).rows[0].n, 0);
      const requests = gateway.requests.length;
      expectStatus(await owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: { expectedVersion: waiting!.version } }), 200);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Pi waits for the owner'`)).rows[0].n, 1);
      assert.equal(gateway.requests.length, requests, 'Apply started no pi and no model request');
    } finally {
      expectStatus(await owner.browser.request('PATCH', agentConnectionPath(settings.connectionId), { body: { mayDo: 'act' } }), 200);
    }
  });

  test('a tool pi was not given stops the run with nothing committed', async () => {
    gateway.script([{ tool: 'grep', args: { pattern: 'x' } }, { text: 'Should not be posted.' }]);
    const started = await ask('Look around');
    await processor.process(started.run.id);
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body], ['local_tool', null]);
    assert.ok(gateway.requests.length >= 1 && lastPi?.events.some((line) => line.includes('"tool_execution_start"') && line.includes('"grep"')), await why(started.run.id));
    assert.deepEqual(await readdir(scratchRoot()), []);
  });
});

describe('pi\'s launcher templates and the protocol (#1441)', () => {
  test('the flags: JSON mode, nothing persisted or discovered, pi\'s MCP only, exactly its four tools and Flux\'s', () => {
    const args = piArgs(true, 'brief', 'claude-haiku-5-5');
    for (const flag of ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline']) assert.ok(args.includes(flag), flag);
    assert.deepEqual(args.slice(args.indexOf('-e'), args.indexOf('-e') + 2), ['-e', 'builtin:mcp']);
    assert.equal(args[args.indexOf('--tools') + 1], 'read,bash,edit,write,mcp__flux__*');
    assert.equal(piArgs(false, 'brief', 'm')[piArgs(false, 'brief', 'm').indexOf('--tools') + 1], 'mcp__flux__*', 'without the sandbox: Flux\'s tools only');
  });

  test('the gateway adapter: each provider\'s wire format below the gateway, the run token by name, no address-based guessing', () => {
    const origin = 'http://runtime-egress:8081';
    assert.deepEqual((['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'] as const).map((provider) => gatewayProvider(provider, origin, 'm', false).baseUrl),
      [`${origin}/anthropic`, `${origin}/openai/v1`, `${origin}/openrouter/api/v1`, `${origin}/gemini/v1beta/openai`, `${origin}/openai_compatible`]);
    // pi's own clients' paths below them are the gateway's (Anthropic's beta client adds `?beta=true`).
    for (const path of ['/anthropic/v1/messages?beta=true', '/openai/v1/responses', '/openrouter/api/v1/chat/completions', '/gemini/v1beta/openai/chat/completions', '/openai_compatible/chat/completions'])
      assert.ok(parseModelGatewayUrl(path), path);
    assert.equal(gatewayProvider('openai', origin, 'm', false).api, 'openai-responses');
    for (const provider of ['openrouter', 'gemini', 'openai_compatible'] as const) {
      const wire = gatewayProvider(provider, origin, 'm', false);
      assert.equal(wire.api, 'openai-completions');
      assert.equal((wire.compat as Record<string, unknown>).supportsDeveloperRole, false);
    }
    assert.equal(gatewayProvider('anthropic', origin, 'm', false).apiKey, '$FLUX_MODEL_GATEWAY_TOKEN', 'the token is named, never written');
    assert.deepEqual(gatewayProvider('gemini', origin, 'm', true).models[0]!.input, ['text', 'image']);
  });

  test('pi\'s errors in Flux\'s categories', () => {
    assert.equal(classifyPiError('402 {"type":"error","error":{"type":"flux_budget_exhausted","code":"flux_budget_exhausted","message":"…"}}'), 'budget');
    assert.equal(classifyPiError('400 Your credit balance is too low to access the Anthropic API'), 'credits');
    assert.equal(classifyPiError('400 prompt is too long: 210000 tokens > 200000 maximum'), 'input_too_large');
    assert.equal(classifyPiError('404 model_not_found'), 'model_unavailable');
    assert.equal(classifyPiError('500 upstream broke'), 'crashed');
  });

  test('a run in pi needs its key\'s provider and model; a plan CLI\'s run takes neither key field', () => {
    const base = { bindingId: randomUUID(), runId: randomUUID(), prompt: 'hi', runToken: 'aa.bb.cc', tools: ['flux_list_contexts'],
      caps: { maxTurns: 5, wallClockSeconds: 60, idleSeconds: 10, maxAnswerBytes: 4096 } };
    const modelToken = `flux_mg_${'a'.repeat(43)}`;
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', modelToken }).ok, true);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'Qwen/Qwen3-32B:free', provider: 'openai_compatible', pictures: true, modelToken }).ok, true);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'm', provider: 'openai' }).ok, false, 'no gateway token');
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', provider: 'openrouter', modelToken }).ok, false, 'no model');
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'm', modelToken }).ok, false, 'no provider');
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: '--flag', provider: 'openai', modelToken }).ok, false);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'claude_code', model: 'sonnet', modelToken }).ok, false);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'claude_code', model: 'sonnet', provider: 'anthropic' }).ok, false);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'claude_code', model: 'Upper/Case' }).ok, false);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'claude_code', model: 'sonnet' }).ok, true);
  });

  test('FLUX_AGENT_RUNTIME takes pi beside the plan CLIs', () => {
    assert.deepEqual(parseRuntimeEngines('pi'), { clients: [], pi: true });
    assert.deepEqual(parseRuntimeEngines('codex, pi ,claude_code'), { clients: ['claude_code', 'codex'], pi: true });
    assert.throws(() => parseRuntimeEngines('pi,pi'));
    assert.throws(() => parseRuntimeEngines('goose'));
  });
});
