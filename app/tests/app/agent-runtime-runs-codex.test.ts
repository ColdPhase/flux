import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PERSONAL_RUNTIME_CONSENT_VERSION, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { createPersonalRunProcessor, noPersonalConnections, REDACTED_SECRET, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { callSupervisor } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { RUN_BRIEF } from '../../apps/runtime/src/supervisor/run.js';
import { CODEX_FEATURE_REVIEW } from '../../apps/runtime/src/supervisor/templates.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeQueue } from './support/personal-runs.js';
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
  const resetFake = async () => { for (const name of ['fake-scenario', 'fake-run.json', 'fake-calls.jsonl', 'fake-rate-limits.json']) await writeFile(join(home(), name), ''); };
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
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'held') ON CONFLICT (slot) DO UPDATE SET state = 'held'`, [slot.config.slot]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [bindingId, owner.id, slot.config.slot]);
    await pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, sign_in_method, auth_method, signed_in_at)
      VALUES ($1, $2, $3, 'codex', 'signed_in', 'device_code', 'chatgpt', now())`, [randomUUID(), owner.id, bindingId]);
    assert.ok((await callSupervisor({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }, { kind: 'bind', bindingId })).ok);

    runs = personalRunUseCases(db, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime: personalRuntimeAvailability(config, db) });
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50,
      runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10 } });
    const status = await runs.status(human(owner));
    assert.deepEqual(status.setup.runtime, { state: 'signed_in', payer: 'chatgpt_plan', accountLabel: null, client: 'codex' }, 'the payer comes from `codex login status`');
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUNTIME_CONSENT_VERSION, agentId, engine: 'runtime' });
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

  test('the consent names the ChatGPT plan and OpenAI; the run is labelled Codex and reserves no money', async () => {
    const status = await runs.status(human(owner));
    assert.equal(status.state, 'ready');
    assert.equal(status.enablement?.consent.payer.organization, 'Your ChatGPT plan');
    assert.equal(status.enablement?.consent.provider, 'openai');
    assert.equal(status.enablement?.connectionId, null);
  });

  test('a run commits its answer; exact argv with every override, prompt on stdin, token only in FLUX_RUN_TOKEN, only allowlisted app-server methods, no transcript', async () => {
    await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }], answer: 'Done: I read {{count}} things.' });
    const started = await ask();
    assert.equal(started.run.runtimeClient, 'codex');
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.answer_body, stored.end_reason, stored.reserved_micros, stored.cost_state, stored.provider, stored.model],
      ['completed', 'Done: I read 2 things.', null, 0, 'unknown', 'openai', 'codex']);
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
    assert.equal(run.overrides.web_search, 'disabled');
    assert.equal(run.overrides.cli_auth_credentials_store, 'file');
    assert.equal(run.overrides.analytics.enabled, false);
    assert.equal(run.overrides.developer_instructions, RUN_BRIEF);
    assert.deepEqual(Object.keys(run.overrides.mcp_servers), ['flux']);
    assert.deepEqual(run.overrides.mcp_servers.flux, { url: `${apiUrl}/mcp`, bearer_token_env_var: 'FLUX_RUN_TOKEN', required: true, enabled_tools: run.allowed });
    assert.ok(run.allowed.length > 0);
    assert.deepEqual([...listed.tools].sort(), [...run.allowed].sort(), 'the route listed exactly the run\'s tools');
    assert.equal(run.authorization, 'run_token');
    assert.ok(run.envNames.includes('FLUX_RUN_TOKEN'));
    assert.ok(!run.argv.some((arg) => /eyJ[A-Za-z0-9_-]{10,}\./.test(arg)), 'the token is never an argument');
    assert.equal(run.persist, false);
    // The app-server client sent only initialize, config/read (the preflight) and nothing else; the app-server never had the token.
    const methods = recorded.filter((entry) => entry.event === 'app_server').map((entry) => entry.method);
    assert.deepEqual(methods.filter((method) => method !== 'initialized'), ['initialize', 'config/read']);
    const appServer = recorded.find((entry) => (entry.argv as string[]).includes('app-server')) as { envNames: string[] };
    assert.ok(!appServer.envNames.includes('FLUX_RUN_TOKEN'), 'the preflight never sees the run token');
    assert.deepEqual(await readdir(home()).then((names) => names.filter((name) => ['sessions', 'archived_sessions', 'history.jsonl'].includes(name))), []);
    assert.deepEqual(await readdir(slot.config.tmpDir), []);
  });

  test('no local tool remains: a command, a file change, web search, another MCP server, a resource tool, a plan list or an error item stops the run at that item', async () => {
    for (const name of ['run_command_execution', 'run_file_change', 'run_web_search', 'run_other_mcp', 'run_resource_tool', 'run_todo_list', 'run_error_item']) {
      await resetFake();
      await scenario(name);
      await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }] });
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'unavailable', name);
      const stored = await row(started.run.id);
      assert.deepEqual([stored.end_reason, stored.answer_body], ['local_tool', null], name);
      const progress = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'assistant_run.changed.v1' AND data->>'step' = 'tool'`, [started.run.id]);
      assert.equal(progress.rowCount, 0, `${name}: stopped at the item, before any Flux call was reported`);
    }
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
    assert.deepEqual(methods, ['initialize', 'config/read', 'initialize', 'account/rateLimits/read']);
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
});
