import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { agentConnectionPath, assistantChangeActionPath, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { createPersonalRunProcessor, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { parseRuntimeEngines, parseSupervisorRequest } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { classifyPiError, gatewayProvider, piArgs, PI_OWN_TOOLS } from '../../apps/runtime/src/supervisor/pi.js';
import { RUN_BRIEF_OWN_TOOLS } from '../../apps/runtime/src/supervisor/run.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { agentSettings } from './support/agent-settings.js';
import { db, pool } from './support/db.js';
import { startFakeGateway, type FakeGateway } from './support/fake-gateway.js';
import { apiUrl } from './support/http.js';
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
  let processor: ReturnType<typeof createPersonalRunProcessor>;

  const ask = (prompt = 'Make a page of the notes') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  const row = async (runId: string) => (await pool.query('SELECT status, end_reason, answer_body, cost_state, engine FROM personal_runs WHERE id = $1', [runId])).rows[0] as Record<string, unknown>;
  const scratchRoot = () => slot.config.sandbox!.scratchRoot;

  before(async () => {
    gateway = await startFakeGateway();
    slot = await startTestSlot({ slot: `runtime-7${Math.floor(Math.random() * 90 + 10)}`, enabled: [], mcpUrl: `${apiUrl}/mcp`, ownTools: true, pi: { modelUrl: gateway.url } });
    manager = createManagerServer({ secret: SECRET, slots: new Map([[slot.config.slot, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }]]), log: () => undefined });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    config = { clients: [], keys: true, commercialTermsAgreedOn: null, idleDays: null, manager: { url: `http://127.0.0.1:${(manager.address() as AddressInfo).port}`, secret: SECRET } };
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state, capacity) VALUES ($1, 'ready', 8) ON CONFLICT (slot) DO UPDATE SET state = 'ready', capacity = 8`, [slot.config.slot]);
    owner = await person('rt-pi');
    ws = await createWorkspace(owner, 'Pi runs');
    place = await createProject(owner, ws.id, 'Reports', 'workspace');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Please turn the notes into a page', clientMessageId: randomUUID() } }), 201) as Conversation;
    runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, runtime: personalRuntimeAvailability(config, db) });
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50, runtimeCaps: { idleSeconds: 20, wallClockSeconds: 60, maxTurns: 10 } });
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
  });
  after(async () => {
    await new Promise<void>((done) => manager.close(() => done()));
    await slot.close();
    await gateway.close();
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
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason, stored.engine], ['completed', null, 'server'], 'an API-key run, run in pi');
    assert.match(String(stored.answer_body), /Done: I made notes\.html\./);
    assert.equal(compute.dispatched.length, 0, 'the worker\'s own loop was not used');
    assert.equal(gateway.requests.length, 3);
    const [first] = gateway.requests;
    assert.equal(first!.path, '/model/v1/messages', 'the Anthropic key speaks Messages to the gateway');
    assert.equal(first!.model, 'claude-sonnet-5');
    const token = first!.authorization?.replace(/^Bearer /, '') ?? '';
    assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/, 'the credential is the run token');
    assert.equal(first!.apiKey, token, 'and never a provider key');
    assert.ok(!gateway.requests.some((request) => /test-key-ref|sk-/.test(`${request.authorization} ${request.apiKey}`)));
    const fluxTools = first!.tools.filter((tool) => tool.startsWith('mcp__flux__'));
    assert.deepEqual(first!.tools.filter((tool) => !tool.startsWith('mcp__flux__')).sort(), [...PI_OWN_TOOLS].sort(), 'pi\'s own tools: read, bash, edit, write; nothing else');
    assert.ok(fluxTools.includes('mcp__flux__flux_list_contexts') && fluxTools.length > 3, JSON.stringify(fluxTools));
    assert.ok(first!.system.includes(RUN_BRIEF_OWN_TOOLS), 'Flux\'s brief is appended to pi\'s own prompt');
    const shell = gateway.requests[1]!.results[0]!.split('\n');
    assert.equal(shell[0], join(scratchRoot(), started.run.id), 'the scratch is the working directory');
    assert.deepEqual(shell.slice(1, 3), ['0', 'notes.html'], 'empty at the start; the file was made there');
    assert.match(gateway.requests[2]!.results[1] ?? '', /Reports|context/i, 'the Flux tool ran through Flux\'s MCP route');
    assert.deepEqual(await readdir(scratchRoot()), [], 'the scratch is gone after the run');
    assert.equal((await readdir(join(slot.config.dataDir))).length, 1, 'the owner got one place in the runtime, made for this run');
  });

  test('the gateway\'s budget refusal ends the run at once, with one request and nothing posted', async () => {
    gateway.script([{ status: 402, body: { type: 'error', error: { type: 'flux_budget', message: 'This key\'s daily budget is used up.' } } }]);
    const started = await ask('Summarize the notes');
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body, stored.cost_state], ['budget', null, 'released']);
    assert.equal(gateway.requests.length, 1, 'pi does not retry a refusal');
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
      assert.equal(await processor.process(started.run.id), 'completed');
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
    assert.deepEqual([gatewayProvider('anthropic', 'http://egress:8080/model', 'm', true).baseUrl, gatewayProvider('openai', 'http://egress:8080/model/', 'm', false).baseUrl],
      ['http://egress:8080/model', 'http://egress:8080/model/v1']);
    assert.equal(gatewayProvider('openai', 'http://e/model', 'm', false).api, 'openai-responses');
    for (const provider of ['openrouter', 'gemini', 'openai_compatible'] as const) {
      const wire = gatewayProvider(provider, 'http://e/model', 'm', false);
      assert.equal(wire.api, 'openai-completions');
      assert.equal((wire.compat as Record<string, unknown>).supportsDeveloperRole, false);
    }
    assert.equal(gatewayProvider('anthropic', 'http://e/model', 'm', false).apiKey, '$FLUX_RUN_TOKEN', 'the token is named, never written');
    assert.deepEqual(gatewayProvider('gemini', 'http://e/model', 'm', true).models[0]!.input, ['text', 'image']);
  });

  test('pi\'s errors in Flux\'s categories', () => {
    assert.equal(classifyPiError('402 {"type":"error","error":{"type":"flux_budget","message":"…"}}'), 'budget');
    assert.equal(classifyPiError('400 Your credit balance is too low to access the Anthropic API'), 'credits');
    assert.equal(classifyPiError('400 prompt is too long: 210000 tokens > 200000 maximum'), 'input_too_large');
    assert.equal(classifyPiError('404 model_not_found'), 'model_unavailable');
    assert.equal(classifyPiError('500 upstream broke'), 'crashed');
  });

  test('a run in pi needs its key\'s provider and model; a plan CLI\'s run takes neither key field', () => {
    const base = { bindingId: randomUUID(), runId: randomUUID(), prompt: 'hi', runToken: 'aa.bb.cc', tools: ['flux_list_contexts'],
      caps: { maxTurns: 5, wallClockSeconds: 60, idleSeconds: 10, maxAnswerBytes: 4096 } };
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'anthropic/claude-haiku-5.5', provider: 'openrouter' }).ok, true);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'Qwen/Qwen3-32B:free', provider: 'openai_compatible', pictures: true }).ok, true);
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', provider: 'openrouter' }).ok, false, 'no model');
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: 'm' }).ok, false, 'no provider');
    assert.equal(parseSupervisorRequest('run', { ...base, client: 'pi', model: '--flag', provider: 'openai' }).ok, false);
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
