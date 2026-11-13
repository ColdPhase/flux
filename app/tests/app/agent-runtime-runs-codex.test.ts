import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { type Conversation, type Project, type Workspace } from '@flux/contracts';
import { createPersonalRunProcessor, noPersonalConnections, NO_WEB_SEARCH_LINE, OPEN_ANY_ADDRESS_LINE, REDACTED_SECRET, RUNTIME_WEB_SEARCH_LINE, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { callSupervisor } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { RUN_BRIEF } from '../../apps/runtime/src/supervisor/run.js';
import { CODEX_FEATURE_REVIEW, CODEX_MODEL_CATALOG } from '../../apps/runtime/src/supervisor/templates.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { chooseModel, FakeCompute, FakeQueue } from './support/personal-runs.js';
import { seedPlanModels } from './support/plan-models.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';
import { waitFor } from './support/wait.js';

// F-022 T6 (#281): a run of the agent in Flux on the owner's own Codex, end to end with fakes, as #280's
// suite does for Claude Code. The real worker processor and runtime engine ask a real runtime-manager (in
// process) to run the TEST ONLY fake `codex exec --json` in a real supervisor's slot; the fake makes REAL MCP
// calls to the API's `/mcp` with the run's token and prints the pinned CLI's JSONL. Its `app-server` answers
// the preflight and the plan-limit read. No subscription, no vendor.

const SECRET = slotSecret();
const queue = new FakeQueue();
const compute = new FakeCompute();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
type Call = Record<string, unknown> & { event?: string };

describe('a run on the owner\'s own Codex in the agent runtime (F-022 T6, #281)', () => {
  let slot: TestSlot; let manager: ReturnType<typeof createManagerServer>; let config: AgentRuntimeConfig;
  let owner: Person; let ws: Workspace; let place: Project; let thread: Conversation;
  let agentId: string; let docId: string; let bindingId: string;
  let runs: ReturnType<typeof personalRunUseCases>;
  let processor: ReturnType<typeof createPersonalRunProcessor>;
  const CANARY = `codex-wiki-canary-${randomBytes(4).toString('hex')}`;

  const home = () => join(slot.config.dataDir, bindingId, 'codex');
  const scenario = (name: string) => writeFile(join(home(), 'fake-scenario'), name);
  const script = (value: Record<string, unknown>) => writeFile(join(home(), 'fake-run.json'), JSON.stringify(value));
  async function calls(): Promise<Call[]> {
    const text = await readFile(join(home(), 'fake-calls.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call);
  }
  const resetFake = async () => { for (const name of ['fake-scenario', 'fake-run.json', 'fake-calls.jsonl', 'fake-rate-limits.json', 'fake-models.json']) await writeFile(join(home(), name), ''); };
  const ask = (prompt = 'What do the notes say about the sensor?') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  async function row(runId: string) {
    return (await pool.query(`SELECT status, end_reason, answer_body, answer_redacted, plan_limit_resets_at, cost_state, reserved_micros, engine,
      run_token_closed_at, provider, model FROM personal_runs WHERE id = $1`, [runId])).rows[0] as Record<string, unknown>;
  }

  before(async () => {
    slot = await startTestSlot({ slot: `runtime-${700 + Math.floor(Math.random() * 99)}`, enabled: ['codex'], mcpUrl: `${apiUrl}/mcp` });
    manager = createManagerServer({ secret: SECRET, slots: new Map([[slot.config.slot, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }]]), log: () => undefined });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    // Codex only: no Anthropic Commercial Terms statement is needed.
    config = { clients: ['codex'], commercialTermsAgreedOn: null, idleDays: null,
      manager: { url: `http://127.0.0.1:${(manager.address() as AddressInfo).port}`, secret: SECRET } };
    owner = await person('rt-codex-owner');
    ws = await createWorkspace(owner, 'Codex runs');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    docId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Sensor notes', body: `The sensor is a PIR. ${CANARY}` } }), 201) as { id: string }).id;

    // The owner's slot and their Codex signed in with ChatGPT, as the console leaves them (`codex login status` said so).
    bindingId = randomUUID();
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'ready') ON CONFLICT (slot) DO UPDATE SET state = 'ready'`, [slot.config.slot]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [bindingId, owner.id, slot.config.slot]);
    await pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, sign_in_method, auth_method, signed_in_at)
      VALUES ($1, $2, $3, 'codex', 'signed_in', 'device_code', 'chatgpt', now())`, [randomUUID(), owner.id, bindingId]);
    await seedPlanModels(pool, bindingId, 'codex');
    assert.ok((await callSupervisor({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }, { kind: 'bind', bindingId })).ok);

    runs = personalRunUseCases(db, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime: personalRuntimeAvailability(config, db) });
    // The operator's web switch on, as a new install has it (C-29): Codex searches with its own search on the cached index (#1065, RT-5).
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
      runtime: managerPersonalRuntime(config, db, { webSearch: true }), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50,
      runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10, maxTurns: 10 } });
    const status = await runs.status(human(owner));
    assert.deepEqual(status.setup.runtime, { state: 'signed_in', payer: 'chatgpt_plan', accountLabel: null, client: 'codex' }, 'the payer comes from `codex login status`');
    await runs.enable(human(owner), { agentId, connection: 'chatgpt_plan', model: 'gpt-6.1-sol' });
  });
  after(async () => {
    await new Promise<void>((done) => manager.close(() => done()));
    await slot.close();
  });
  beforeEach(async () => {
    compute.dispatched = [];
    await resetFake();
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('the assistant runs on the ChatGPT plan with OpenAI; the run is labelled Codex and reserves no money (#854)', async () => {
    const status = await runs.status(human(owner));
    assert.equal(status.state, 'ready');
    assert.deepEqual([status.enablement?.connection, status.enablement?.engine, status.enablement?.model], ['chatgpt_plan', 'runtime', 'gpt-6.1-sol']);
    const stored = (await pool.query('SELECT api_key_id AS connection_id, provider FROM assistant_settings WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0];
    assert.deepEqual(stored, { connection_id: null, provider: 'openai' });
  });

  test('a run commits its answer; exact argv with every override, prompt on stdin, token only in FLUX_RUN_TOKEN, only allowlisted app-server methods, no transcript', async () => {
    await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }], answer: 'Done: I read {{count}} things.' });
    const started = await ask();
    assert.equal(started.run.runtimeClient, 'codex');
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.answer_body, stored.end_reason, stored.reserved_micros, stored.cost_state, stored.provider, stored.model],
      ['completed', 'Done: I read 2 things.', null, 0, 'unknown', 'openai', 'gpt-6.1-sol']);
    const progress = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'assistant_run.changed.v1' ORDER BY seq`, [started.run.id]);
    assert.deepEqual(progress.rows.filter((r) => r.data.step === 'tool').map((r) => r.data.tool), ['flux_list_contexts', 'flux_get_doc']);
    const recorded = await calls();
    const run = recorded.find((entry) => entry.event === 'run') as { argv: string[]; envNames: string[]; authorization: string; persist: boolean; allowed: string[]; prompt: string; overrides: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const listed = recorded.find((entry) => entry.event === 'tools_list') as { tools: string[] };
    assert.deepEqual(run.argv.slice(0, 7), ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check']);
    assert.equal(run.argv.at(-1), '-', 'the prompt is read from stdin');
    assert.ok(run.prompt.includes('What do the notes say about the sensor?') && run.prompt.includes(place.id));
    // Every reviewed default-on feature off, memories off, web search disabled, Flux the only, required MCP server with the exact list.
    for (const [key, review] of Object.entries(CODEX_FEATURE_REVIEW)) if (review.action === 'off') assert.equal(run.overrides.features[key], false, key);
    for (const key of ['shell_tool', 'unified_exec', 'apps', 'multi_agent', 'skill_mcp_dependency_install', 'hooks', 'goals', 'remote_plugin', 'memories', 'view_image'])
      assert.equal(run.overrides.features[key], false, `named in #281: ${key}`);
    assert.equal(run.overrides.web_search, 'cached', 'with the web on, Codex\'s own search on OpenAI\'s cached index (#1065)');
    assert.equal(run.overrides.features.standalone_web_search, undefined, 'and no search feature switched on: the pinned Codex picks its search by model');
    assert.ok(run.prompt.includes(RUNTIME_WEB_SEARCH_LINE) && !run.prompt.includes(NO_WEB_SEARCH_LINE), 'and its brief says it can search');
    assert.equal(run.overrides.cli_auth_credentials_store, 'file');
    assert.equal(run.overrides.analytics.enabled, false);
    assert.equal(run.overrides.developer_instructions, RUN_BRIEF);
    assert.deepEqual(Object.keys(run.overrides.mcp_servers), ['flux']);
    assert.deepEqual(run.overrides.mcp_servers.flux, { url: `${apiUrl}/mcp`, bearer_token_env_var: 'FLUX_RUN_TOKEN', required: true, enabled_tools: run.allowed,
      default_tools_approval_mode: 'approve' });
    // #1127: Flux's model catalog (plain tools, no code mode or sub-agents), cut down to the account's models for this run (#1332), and no request_user_input.
    assert.match(run.overrides.model_catalog_json, /\/run-[0-9a-f-]+\/models\.json$/);
    assert.notEqual(run.overrides.model_catalog_json, CODEX_MODEL_CATALOG);
    assert.equal(run.overrides.tools.experimental_request_user_input.enabled, false);
    assert.ok(run.allowed.length > 0);
    assert.deepEqual([...listed.tools].sort(), [...run.allowed].sort(), 'the route listed exactly the run\'s tools');
    assert.equal(run.authorization, 'run_token');
    assert.ok(run.envNames.includes('FLUX_RUN_TOKEN'));
    assert.ok(!run.argv.some((arg) => /eyJ[A-Za-z0-9_-]{10,}\./.test(arg)), 'the token is never an argument');
    assert.equal(run.persist, false);
    // The app-server client sent only model/list (the account's models, just before the run: #1332), config/read (the preflight) and, after the
    // run, what is left of the plan for its usage line (#854), and nothing else; the app-server never had the token.
    const methods = recorded.filter((entry) => entry.event === 'app_server').map((entry) => entry.method);
    assert.deepEqual(methods.filter((method) => method !== 'initialized'), ['initialize', 'model/list', 'initialize', 'config/read', 'initialize', 'account/rateLimits/read']);
    const appServer = recorded.find((entry) => (entry.argv as string[]).includes('app-server')) as { envNames: string[] };
    assert.ok(!appServer.envNames.includes('FLUX_RUN_TOKEN'), 'the preflight never sees the run token');
    // #1133: the usage read runs with the run's settings too (plugins and apps off), so it never calls ChatGPT's plugin endpoints.
    const usageRead = recorded.find((entry) => entry.event === 'app_server' && entry.method === 'account/rateLimits/read') as { argv: string[] };
    for (const key of ['features.plugins=false', 'features.apps=false', 'features.remote_plugin=false', 'web_search="cached"']) assert.ok(usageRead.argv.includes(key), `the usage read has ${key}`);
    assert.deepEqual(await readdir(home()).then((names) => names.filter((name) => ['sessions', 'archived_sessions', 'history.jsonl'].includes(name))), []);
    assert.deepEqual(await readdir(slot.config.tmpDir), []);
  });

  test('no local tool remains: a command, a file change, web search with the web off, another MCP server, a resource reader of another server, a plan list or an error item stops the run at that item', async () => {
    const webOff = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50, runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10, maxTurns: 10 } });
    for (const name of ['run_command_execution', 'run_file_change', 'run_web_search', 'run_other_mcp', 'run_resource_tool', 'run_todo_list', 'run_error_item']) {
      await resetFake();
      await scenario(name);
      await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }] });
      const started = await ask();
      assert.equal(await (name === 'run_web_search' ? webOff : processor).process(started.run.id), 'unavailable', name);
      const stored = await row(started.run.id);
      assert.deepEqual([stored.end_reason, stored.answer_body], ['local_tool', null], name);
      const progress = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'assistant_run.changed.v1' AND data->>'step' = 'tool'`, [started.run.id]);
      assert.equal(progress.rowCount, 0, `${name}: stopped at the item, before any Flux call was reported`);
    }
  });

  test('#1165: Codex\'s own resource readers reach only Flux, which has none and opens no address; the run goes on to a Flux tool and answers', async () => {
    const PLAYBOOK = 'flux://playbook/flux.cowork/1.0.0';
    await script({ calls: [
      { name: 'list_mcp_resources' },
      { name: 'list_mcp_resources', args: { server: 'flux' } },
      { name: 'list_mcp_resource_templates', args: { server: 'flux' } },
      { name: 'read_mcp_resource', args: { server: 'flux', uri: PLAYBOOK } },
      { name: 'read_mcp_resource', args: { server: 'flux', uri: 'http://169.254.169.254/latest/meta-data/' } },
      { name: 'flux_list_contexts' },
    ], answer: '{{results}}' });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason], ['completed', null]);
    // Flux's answers, as the CLI got them in the 2025-06-18 era it speaks: none, none, none, and not found for any address.
    const asked = (await calls()).filter((entry) => entry.event === 'resource_request').map((entry) => [entry.method, entry.status, entry.answer]);
    const notFound = (id: number) => ({ jsonrpc: '2.0', id, error: { code: -32002, message: 'Resource not found' } });
    assert.deepEqual(asked, [
      ['resources/list', 200, { jsonrpc: '2.0', id: 2, result: { resources: [] } }],
      ['resources/list', 200, { jsonrpc: '2.0', id: 3, result: { resources: [] } }],
      ['resources/templates/list', 200, { jsonrpc: '2.0', id: 4, result: { resourceTemplates: [] } }],
      ['resources/read', 200, notFound(5)],
      ['resources/read', 200, notFound(6)],
    ]);
    const answer = String(stored.answer_body);
    assert.ok(!answer.includes('co-work playbook') && !answer.includes('cowork_playbook'), 'a run never reads the playbook a client may read');
    assert.ok(answer.includes(place.id), 'the Flux tool after the readers answered');
    // Only the Flux tool is reported to the owner; the readers are turns, not Flux tool calls.
    const progress = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'assistant_run.changed.v1' ORDER BY seq`, [started.run.id]);
    assert.deepEqual(progress.rows.filter((r) => r.data.step === 'tool').map((r) => r.data.tool), ['flux_list_contexts']);

    // They count toward the turn cap: a model that keeps listing ends at it.
    await resetFake();
    await script({ calls: Array.from({ length: 12 }, () => ({ name: 'list_mcp_resources' })) });
    const looping = await ask();
    assert.equal(await processor.process(looping.run.id), 'cap_reached');
    assert.deepEqual([(await row(looping.run.id)).end_reason, (await row(looping.run.id)).answer_body], ['max_turns', null]);
  });

  test('the blocking preflight: a config/read that does not reflect the overrides refuses the run before `codex exec` starts', async () => {
    await scenario('config_ignores_overrides');
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'unavailable');
    assert.deepEqual([(await row(started.run.id)).end_reason, (await row(started.run.id)).answer_body], ['local_tool', null]);
    assert.equal((await calls()).filter((entry) => entry.event === 'run').length, 0, 'exec never started');
  });

  test('plan limit in two steps: the text marker, then account/rateLimits/read for the reset; unreadable is unknown, never zero; no API key', async () => {
    await scenario('run_plan_limit');
    const first = await ask();
    assert.equal(await processor.process(first.run.id), 'unavailable');
    const stored = await row(first.run.id);
    assert.equal(stored.end_reason, 'plan_limit');
    assert.equal((stored.plan_limit_resets_at as Date).toISOString(), new Date(1791374400 * 1000).toISOString(), 'the reset of the window at 100 %');
    const methods = (await calls()).filter((entry) => entry.event === 'app_server').map((entry) => entry.method).filter((method) => method !== 'initialized');
    assert.deepEqual(methods, ['initialize', 'model/list', 'initialize', 'config/read', 'initialize', 'account/rateLimits/read']);
    await resetFake();
    await writeFile(join(home(), 'fake-scenario'), 'run_plan_limit');
    await writeFile(join(home(), 'fake-rate-limits.json'), JSON.stringify({ primary: { usedPercent: 'n/a' } }));
    const second = await ask();
    assert.equal(await processor.process(second.run.id), 'unavailable');
    assert.deepEqual([(await row(second.run.id)).end_reason, (await row(second.run.id)).plan_limit_resets_at], ['plan_limit', null]);
    assert.equal(compute.dispatched.length, 0);
  });

  test('expired login, both timeouts, crash, oversized output, a broken stream and the turn cap each end in their own state', async () => {
    const expected: [string, string, string, Record<string, unknown>?][] = [
      ['run_expired_login', 'unavailable', 'sign_in_again'],
      ['run_hang', 'provider_failed', 'no_event'],
      ['run_slow', 'cap_reached', 'wall_clock'],
      ['run_crash', 'provider_failed', 'crashed'],
      ['run_big_answer', 'cap_reached', 'answer_too_large'],
      ['run_broken_stream', 'provider_failed', 'unknown'],
      ['', 'cap_reached', 'max_turns', { calls: Array.from({ length: 12 }, () => ({ name: 'flux_list_contexts' })) }],
    ];
    for (const [name, status, reason, plan] of expected) {
      await resetFake();
      if (name) await scenario(name);
      if (plan) await script(plan);
      const started = await ask();
      assert.equal(await processor.process(started.run.id), status, name || 'max_turns');
      assert.deepEqual([(await row(started.run.id)).end_reason, (await row(started.run.id)).answer_body], [reason, null], name || 'max_turns');
      assert.equal((await calls()).filter((entry) => entry.event === 'run').length, 1, `${name}: never rerun`);
      if (name === 'run_expired_login') {
        // #1129: the dead sign-in shows *Sign in again* in Settings too, so no next run starts on it; the owner signs in again.
        const signIn = await pool.query<{ state: string }>(`SELECT state FROM agent_runtime_connections WHERE owner_user_id = $1 AND client = 'codex'`, [owner.id]);
        assert.equal(signIn.rows[0]?.state, 'sign_in_again');
        await pool.query(`UPDATE agent_runtime_connections SET state = 'signed_in', signed_in_at = now() WHERE owner_user_id = $1 AND client = 'codex'`, [owner.id]);
      }
    }
    assert.equal(compute.dispatched.length, 0);
  });

  test('Stop ends the CLI; a token-shaped string or the run token in the answer is redacted', async () => {
    await scenario('run_secret_answer');
    const leaked = await ask();
    assert.equal(await processor.process(leaked.run.id), 'completed');
    const stored = await row(leaked.run.id);
    assert.equal(stored.answer_redacted, true);
    assert.ok(String(stored.answer_body).includes(REDACTED_SECRET));
    assert.doesNotMatch(String(stored.answer_body), /sk-proj-|eyJ/);
    for (const name of ['run_slow', 'run_ignore_sigint']) {
      await resetFake();
      await scenario(name);
      const started = await ask();
      const processing = processor.process(started.run.id);
      await waitFor(async () => (await calls()).some((entry) => entry.event === 'tools_list'), 'the CLI started');
      await runs.stop(human(owner), started.run.id);
      assert.equal(await processing, 'stopped', name);
      const stopped = await row(started.run.id);
      assert.equal(stopped.answer_body, null, name);
    }
  });

  test('AST-11: the chosen model reaches Codex as -m; an unaccepted model ends the run as its own state', async () => {
    const argvOf = async () => ((await calls()).find((entry) => entry.event === 'run') as { argv: string[] }).argv;
    const flag = (argv: string[]) => (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null);
    await script({ calls: [], answer: 'Done.' });
    let choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.default], [{ connection: 'chatgpt_plan', model: 'gpt-6.1-sol' }, { connection: 'chatgpt_plan', model: 'gpt-6.1-sol' }]);
    assert.deepEqual(choice.groups.map((group) => [group.account, group.company, group.options.map((option) => option.id)]),
      [['chatgpt_plan', 'ChatGPT', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']]]);
    const first = await ask();
    assert.equal(await processor.process(first.run.id), 'completed');
    assert.equal(flag(await argvOf()), 'gpt-6.1-sol');
    assert.equal((await row(first.run.id)).model, 'gpt-6.1-sol');

    choice = await chooseModel(runs, human(owner), { connection: 'chatgpt_plan', model: 'gpt-6-luna' });
    assert.deepEqual(choice.current, { connection: 'chatgpt_plan', model: 'gpt-6-luna' });
    await resetFake(); await script({ calls: [], answer: 'Done.' });
    const chosen = await ask();
    assert.equal(await processor.process(chosen.run.id), 'completed');
    const argv = await argvOf();
    assert.equal(flag(argv), 'gpt-6-luna');
    assert.ok(argv.indexOf('-m') < argv.indexOf('-'), 'before the prompt marker');
    assert.equal((await row(chosen.run.id)).model, 'gpt-6-luna');
    await assert.rejects(chooseModel(runs, human(owner), { connection: 'chatgpt_plan', model: 'sonnet' }), (error: unknown) => (error as Error).message === 'Your ChatGPT plan doesn\'t offer that model. It is still GPT-6-Luna.');

    await resetFake(); await scenario('run_model_unavailable');
    const refused = await ask();
    assert.equal(await processor.process(refused.run.id), 'unavailable');
    assert.deepEqual([(await row(refused.run.id)).end_reason, (await row(refused.run.id)).answer_body], ['model_unavailable', null]);
    assert.deepEqual((await runs.model(human(owner))).current, { connection: 'chatgpt_plan', model: 'gpt-6-luna' });
  });
  test('#1332: a run\'s model catalog is the reviewed one cut down to the account\'s models, and a model the account lacks never starts the CLI', async () => {
    const ran = async () => (await calls()).filter((entry) => entry.event === 'run') as unknown as { catalogSlugs: string[] | null; overrides: { model_catalog_json?: string } }[];
    await resetFake(); await script({ calls: [], answer: 'Done.' });
    await chooseModel(runs, human(owner), { connection: 'chatgpt_plan', model: 'gpt-6.1-sol' });
    const first = await ask();
    assert.equal(await processor.process(first.run.id), 'completed');
    const [run] = await ran();
    // The fixture catalog holds five models and a hidden one; the account lists three (and hides one): the run's catalog is exactly those three.
    assert.deepEqual(run!.catalogSlugs, ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], 'no model the account lacks, and the hidden one is not offered either');
    assert.notEqual(run!.overrides.model_catalog_json, CODEX_MODEL_CATALOG, 'the run\'s own catalog, not the image\'s whole copy');
    assert.match(String(run!.overrides.model_catalog_json), /\/run-[0-9a-f-]+\/models\.json$/);
    const listing = (await calls()).filter((entry) => entry.event === 'app_server' && entry.method === 'model/list');
    assert.equal(listing.length, 1, 'the account\'s list was read once, just before the run');

    // The account stops offering a model between Flux's last reading and the request: the catalog loses it, and a run on it never starts.
    await resetFake(); await script({ calls: [], answer: 'Done.' });
    await writeFile(join(home(), 'fake-models.json'), JSON.stringify([{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: true }]));
    const lost = await ask();
    assert.equal(await processor.process(lost.run.id), 'unavailable');
    assert.deepEqual([(await row(lost.run.id)).end_reason, (await row(lost.run.id)).answer_body], ['model_unavailable', null]);
    assert.equal((await ran()).length, 0, 'the CLI was not started on a model its account lacks');
    // The same account on a model it still lists: the catalog is what is left.
    await chooseModel(runs, human(owner), { connection: 'chatgpt_plan', model: 'gpt-6-astra' });
    const still = await ask();
    assert.equal(await processor.process(still.run.id), 'completed');
    assert.deepEqual((await ran())[0]!.catalogSlugs, ['gpt-6-astra']);

    // An account whose list cannot be read ends the run as a crash (nothing is guessed), before the CLI starts.
    await resetFake(); await scenario('models_unreadable');
    const blind = await ask();
    assert.equal(await processor.process(blind.run.id), 'provider_failed');
    assert.equal((await row(blind.run.id)).end_reason, 'crashed');
    assert.equal((await ran()).length, 0);
    await resetFake();
    await chooseModel(runs, human(owner), { connection: 'chatgpt_plan', model: 'gpt-6-luna' });
  });

  describe('#1065: Codex searches with its own search, opens any address but one carrying what it read in Flux, and lists its searches (C-30)', () => {
    // The fake prints the pinned CLI's `web_search` item; flux_read_web reads the link mock as public.test.
    const at = (path: string) => `http://public.test${path}`;
    const searchRows = async (runId: string) => (await pool.query(`SELECT queries, results, cited FROM personal_run_web_searches
      WHERE run_id = $1 ORDER BY searched_at, id`, [runId])).rows as { queries: string[]; results: string[]; cited: string[] }[];
    const reads = async () => (await calls()).filter((entry) => entry.event === 'tool_result' && entry.name === 'flux_read_web') as unknown as { isError: boolean; text: string }[];
    const refusal = (read: { text: string } | undefined) => { try { return (JSON.parse(read?.text ?? '') as { code?: string }).code; } catch { return undefined; } };

    test('a search item is accepted and its query recorded and listed; the pages it found open, and so does any address but one carrying the request\'s words', async () => {
      const query = 'island ferry winter timetable';
      await script({ calls: [
        { name: 'web_search', args: { query } },
        { name: 'flux_read_web', args: { url: at('/read/timetable') } },
        { name: 'flux_read_web', args: { url: at('/read/second') } },
        { name: 'flux_read_web', args: { url: `${at('/read/collect')}?d=${encodeURIComponent('our secret harbour plan')}` } },
      ], answer: `The last boat leaves the island at 17:40 (${at('/read/timetable')}).` });
      const started = await ask('When does the last boat leave the island? Keep our secret harbour plan out of it.');
      assert.equal(await processor.process(started.run.id), 'completed');
      const run = (await calls()).find((entry) => entry.event === 'run') as { prompt: string };
      assert.ok(run.prompt.includes(OPEN_ANY_ADDRESS_LINE), 'the brief: any address, never anything from Flux in it');
      const [found, other, withWords] = await reads();
      assert.equal(found?.isError, false, found?.text);
      assert.equal(other?.isError, false, other?.text);
      assert.deepEqual([withWords?.isError, refusal(withWords)], [true, 'WEB_READ_PRIVATE_TEXT']);
      assert.deepEqual((await searchRows(started.run.id))[0], { queries: [query], results: [], cited: [] }, 'an item without results (the hosted search) names its query only');
      assert.equal((await row(started.run.id)).answer_body, `The last boat leaves the island at 17:40 (${at('/read/timetable')}).\n\n`
        + `Searched the web for:\n- ${query}\nRead on the web:\n- ${at('/read/timetable')}\n- ${at('/read/second')}`);
    });

    test('the stored answer has no mark the model invented and no "Źródła:" block of its own: Flux\'s list is the only one (#1222)', async () => {
      await script({ calls: [
        { name: 'web_search', args: { query: 'harbour notes' }, results: [{ title: 'Notes', url: at('/read/notes') }] },
      ], answer: `Notes are published weekly [8]【3†source】, see ${at('/read/notes')}.\n\nŹródła:\n[1] Notes: ${at('/read/notes')}` });
      const started = await ask('What do the harbour notes say?');
      assert.equal(await processor.process(started.run.id), 'completed');
      const body = String((await row(started.run.id)).answer_body);
      assert.equal(body, `Notes are published weekly, see ${at('/read/notes')}.\n\nSearched the web for:\n- harbour notes\nFound on the web:\n- ${at('/read/notes')}`);
    });

    test('structured results, when the item carries them, are recorded: search result entries only, never a page the model opened', async () => {
      await script({ calls: [
        { name: 'web_search', args: { query: 'harbour notes' }, results: [{ title: 'Notes', url: at('/read/notes') }],
          rawResults: [{ type: 'text_result', ref_id: 'turn0view0', url: at('/read/links'), title: 'Opened' }, { type: 'image_result', ref_id: 'turn0search9', url: at('/read/second') }] },
        { name: 'web_search', args: {}, action: { type: 'open_page', url: at('/read/hidden') } },
      ], answer: `See ${at('/read/notes')} and ${at('/read/links')}.` });
      const started = await ask('What do the harbour notes say?');
      assert.equal(await processor.process(started.run.id), 'completed');
      const rows = await searchRows(started.run.id);
      assert.deepEqual(rows.slice(0, 2), [{ queries: ['harbour notes'], results: [at('/read/notes')], cited: [] }, { queries: [], results: [], cited: [] }]);
      assert.ok(String((await row(started.run.id)).answer_body).endsWith(`Searched the web for:\n- harbour notes\nFound on the web:\n- ${at('/read/notes')}`),
        'only an address its search returned is listed as found');
    });
  });
});
