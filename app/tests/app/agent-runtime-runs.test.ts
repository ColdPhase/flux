import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assistantChangeActionPath, assistantSettingsPath, ASSISTANT_UNIT_CREATE_VIEW, PERSONAL_RUNTIME_CONSENT_VERSION, type AssistantSettings, type Conversation, type Project,
  type Workspace,
} from '@flux/contracts';
import { createPersonalRunProcessor, noPersonalConnections, REDACTED_SECRET, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { callSupervisor, type SupervisorRequest } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { RUN_BRIEF } from '../../apps/runtime/src/supervisor/run.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { managerPersonalRuntime } from '../../apps/worker/src/personal-runs/runtime-engine.js';
import { db, pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { apiUrl } from './support/http.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeQueue } from './support/personal-runs.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';
import { waitFor } from './support/wait.js';

// F-022 T5 (#280): the first owner-invoked run of the agent in Flux on Claude Code, end to end with fakes.
// The real worker processor and runtime engine ask a real runtime-manager (in process) to run the TEST
// ONLY fake `claude` in a real supervisor's slot (in process, temporary /data and /tmp); the fake makes
// REAL MCP calls to the API's `/mcp` with the run's token, minted by the API. No subscription, no vendor.

const SECRET = slotSecret();
const queue = new FakeQueue();
const compute = new FakeCompute();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

describe('a run on the owner\'s own Claude Code in the agent runtime (F-022 T5, #280)', () => {
  let slot: TestSlot; let manager: ReturnType<typeof createManagerServer>; let config: AgentRuntimeConfig;
  let owner: Person; let ws: Workspace; let place: Project; let other: Project; let thread: Conversation;
  let agentId: string; let docId: string; let bigDocId: string; let otherDocId: string;
  let bindingId: string; let slotName: string;
  let runs: ReturnType<typeof personalRunUseCases>;
  let processor: ReturnType<typeof createPersonalRunProcessor>;
  const WIKI_CANARY = `wiki-canary-${randomBytes(4).toString('hex')}`;
  const OTHER_CANARY = `other-project-canary-${randomBytes(4).toString('hex')}`;
  const DM_CANARY = `dm-canary-${randomBytes(4).toString('hex')}`;
  const PRIVATE_CANARY = `private-sketch-canary-${randomBytes(4).toString('hex')}`;

  const home = () => join(slot.config.dataDir, bindingId, 'claude');
  const scenario = (name: string) => writeFile(join(home(), 'fake-scenario'), name);
  const script = (value: Record<string, unknown>) => writeFile(join(home(), 'fake-run.json'), JSON.stringify(value));
  async function calls() {
    const text = await readFile(join(home(), 'fake-calls.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  const resetFake = async () => { for (const name of ['fake-scenario', 'fake-run.json', 'fake-calls.jsonl']) await writeFile(join(home(), name), ''); };
  const ask = (prompt = 'What do the notes say about the sensor?') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  async function row(runId: string) {
    return (await pool.query(`SELECT status, end_reason, answer_body, answer_redacted, plan_limit_resets_at, stop_requested_at, stop_acknowledged_at, cost_state,
      reserved_micros, engine, run_token_closed_at, provider, model FROM personal_runs WHERE id = $1`, [runId])).rows[0] as Record<string, unknown>;
  }
  const settings = async () => expectStatus(await owner.browser.request('GET', assistantSettingsPath(ws.id, owner.id)), 200) as unknown as AssistantSettings;
  async function setWiki(mode: 'off' | 'edit') {
    const current = await settings();
    expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(ws.id, owner.id), { body: { areas: { wiki: mode } }, headers: { 'if-match': `"${current.version}"` } }), 200);
  }
  async function filesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await filesUnder(path)); else out.push(path);
    }
    return out;
  }

  before(async () => {
    slot = await startTestSlot({ slot: `runtime-${800 + Math.floor(Math.random() * 99)}`, enabled: ['claude_code'], mcpUrl: `${apiUrl}/mcp` });
    slotName = slot.config.slot;
    manager = createManagerServer({ secret: SECRET, slots: new Map([[slotName, { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }]]), log: () => undefined });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    config = { clients: ['claude_code'], commercialTermsAgreedOn: '2026-10-05', idleDays: null,
      manager: { url: `http://127.0.0.1:${(manager.address() as AddressInfo).port}`, secret: SECRET } };
    owner = await person('rt-run-owner');
    ws = await createWorkspace(owner, 'Runtime runs');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    other = await createProject(owner, ws.id, 'Other project', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    docId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Sensor notes', body: `The sensor is a PIR. ${WIKI_CANARY}` } }), 201) as { id: string }).id;
    bigDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Big log', body: 'log line. '.repeat(2_000) } }), 201) as { id: string }).id;
    otherDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${other.id}/docs`, { body: { title: 'Elsewhere', body: OTHER_CANARY } }), 201) as { id: string }).id;
    const privateMap = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: PRIVATE_CANARY, scope: 'private' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${privateMap.id}/thoughts`, { body: { text: PRIVATE_CANARY, x: 0, y: 0 } }), 201);
    const peer = await person('rt-run-peer');
    await addMember(owner, ws.id, peer, 'member');
    const opened = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [peer.id] } });
    expectStatus(await owner.browser.request('POST', `/api/v1/dms/${(opened.json as { id: string }).id}/messages`, { body: { body: DM_CANARY, clientMessageId: randomUUID() } }), 201);

    // The owner's slot and their Claude Code signed in, as T3/T4 leave them (the CLI's status said so).
    bindingId = randomUUID();
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'held') ON CONFLICT (slot) DO UPDATE SET state = 'held'`, [slotName]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [bindingId, owner.id, slotName]);
    await pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, sign_in_method, auth_method, account_label, signed_in_at)
      VALUES ($1, $2, $3, 'claude_code', 'signed_in', 'claude_account', 'claude.ai', 'o***@example.org', now())`, [randomUUID(), owner.id, bindingId]);
    assert.ok((await callSupervisor({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }, { kind: 'bind', bindingId })).ok);

    runs = personalRunUseCases(db, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime: personalRuntimeAvailability(config, db) });
    processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50,
      runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10 } });
    const status = await runs.status(human(owner));
    assert.equal(status.setup.runtime.state, 'signed_in');
    assert.equal(status.setup.runtime.payer, 'claude_plan', 'the payer comes from the CLI\'s reported authMethod');
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
    // Each test starts a fresh day: this suite runs more than one day's 20 requests (the cap has its own test).
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
    await setWiki('edit');
  });

  test('the consent names the owner\'s plan; a run reserves no money and needs no API key connection', async () => {
    const status = await runs.status(human(owner));
    assert.equal(status.state, 'ready');
    assert.equal(status.enablement?.engine, 'runtime');
    assert.equal(status.enablement?.consent.version, PERSONAL_RUNTIME_CONSENT_VERSION);
    assert.equal(status.enablement?.consent.payer.organization, 'Your Claude plan');
    assert.equal(status.enablement?.connectionId, null);
  });

  test('AST-2.3: an O-007 comparison rule cannot run on the runtime; enabling one still needs an API-key background connection', async () => {
    const rule = await owner.browser.request('POST', `/api/v1/projects/${place.id}/proactive-comparison-rules`, { body: {
      agentId, maxRunsPerDay: 1, periodBudgetCents: 100, perRunCents: 10, purpose: 'camera_sensor_comparison', dataScope: 'current_project_published',
      permittedEffect: 'quiet_project_proposal', trigger: 'human_negative_result' } });
    if (rule.status === 201) {
      const created = rule.json as { id: string; version: number };
      const enabled = await owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${created.id}`, { body: { expectedVersion: created.version, status: 'enabled' } });
      assert.equal(enabled.status, 409);
      assert.equal((enabled.json as { code?: string }).code, 'BACKGROUND_CONNECTION_REQUIRED', 'a signed-in Claude Code is never a background compute source');
    } else {
      assert.ok(rule.status >= 400 && rule.status < 500, `refused: ${rule.status}`);
    }
  });

  test('a run streams progress and commits its answer only after the access recheck; exact argv, token only in FLUX_RUN_TOKEN and the Authorization header, no transcript left', async () => {
    await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }], answer: 'Done: I read {{count}} things.' });
    const started = await ask();
    assert.equal(started.run.engine, 'runtime');
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.answer_body, stored.end_reason, stored.reserved_micros, stored.cost_state, stored.provider, stored.model],
      ['completed', 'Done: I read 2 things.', null, 0, 'unknown', 'anthropic', 'claude-code'], 'plan usage is not visible to Flux: unknown, never zero');
    assert.ok(stored.run_token_closed_at, 'the token was closed');
    // Progress: one owner-only event per Flux tool call, besides the status changes.
    const progress = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'assistant_run.changed.v1' ORDER BY seq`, [started.run.id]);
    assert.deepEqual(progress.rows.filter((r) => r.data.step === 'tool').map((r) => r.data.tool), ['flux_list_contexts', 'flux_get_doc']);
    assert.ok(progress.rows.some((r) => r.data.status === 'dispatching') && progress.rows.at(-1).data.status === 'completed');
    const recorded = await calls();
    const run = recorded.find((entry) => entry.event === 'run') as { argv: string[]; envNames: string[]; authorization: string; persist: boolean; allowed: string[]; prompt: string };
    const listed = recorded.find((entry) => entry.event === 'tools_list') as { tools: string[] };
    const tools = [...listed.tools].sort();
    assert.deepEqual(run.argv.slice(0, 12), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--restricted', '--tools', '',
      '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', run.argv[11]!]);
    assert.ok(run.argv[11]!.startsWith(slot.config.tmpDir), 'the MCP configuration is on tmpfs');
    assert.deepEqual(run.argv.slice(12), ['--allowedTools', ...run.allowed, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--no-session-persistence', '--max-turns', '10', '--append-system-prompt', RUN_BRIEF]);
    assert.deepEqual([...run.allowed].sort(), tools.map((tool) => `mcp__flux__${tool}`), 'the exact Flux tools, named, no wildcard; the route listed exactly these');
    assert.equal(run.authorization, 'run_token', 'FLUX_RUN_TOKEN reaches the Flux MCP Authorization header');
    assert.ok(run.envNames.includes('FLUX_RUN_TOKEN'));
    assert.equal(run.persist, false);
    assert.ok(run.prompt.includes('What do the notes say about the sensor?') && run.prompt.includes(place.id), 'the prompt goes on stdin with the place');
    assert.ok(!run.argv.some((arg) => /^eyJ/.test(arg)), 'the token is never an argument');
    for (const entry of recorded.filter((e) => e.event === 'tool_result')) assert.equal(entry.isError, false, String(entry.name));
    // No transcript and no MCP configuration remain; no file holds the token.
    assert.deepEqual(await readdir(join(home())).then((names) => names.filter((name) => ['projects', 'todos', 'transcripts'].includes(name))), []);
    assert.deepEqual(await readdir(slot.config.tmpDir), []);
    for (const file of await filesUnder(join(slot.config.dataDir, bindingId))) assert.doesNotMatch(await readFile(file, 'utf8').catch(() => ''), /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, file);
  });

  test('F-024: provider suspension stops runtime before launch, during tools and before commit; retained consent recovers', async () => {
    const suspend = () => pool.query(`INSERT INTO auth_idp_standing (user_id, provider_id, state, reason)
      VALUES ($1, 'oidc-standing-fixture', 'sign_in_required', 'invalid_grant')
      ON CONFLICT (user_id, provider_id) DO UPDATE SET state = 'sign_in_required'`, [owner.id]);
    const recover = () => pool.query(`DELETE FROM auth_idp_standing WHERE user_id = $1 AND provider_id = 'oidc-standing-fixture'`, [owner.id]);
    try {
      const before = await ask(); await suspend();
      assert.equal(await processor.process(before.run.id), 'revoked');
      assert.equal((await calls()).filter((call) => call.event === 'run').length, 0, 'no CLI compute started');
      await recover();
      await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_list_contexts' }], delayMs: 3_000, answer: 'withhold' });
      const active = await ask(); const processing = processor.process(active.run.id);
      await waitFor(async () => (await calls()).some((call) => call.event === 'tool_result'), 'the runtime read');
      await suspend();
      assert.equal(await processing, 'revoked');
      assert.equal((await row(active.run.id)).answer_body, null);
      await recover(); await resetFake();
      const finalGuard = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
        runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50,
        runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10 }, hooks: { afterDispatch: async () => { await suspend(); } } });
      const final = await ask();
      assert.equal(await finalGuard.process(final.run.id), 'revoked');
      assert.equal((await row(final.run.id)).answer_body, null);
    } finally { await recover(); await resetFake(); }
    const resumed = await ask();
    assert.equal(await processor.process(resumed.run.id), 'completed', 'no replacement consent, grant or payer');
  });

  test('the answer is withheld when access changed after the run started (the commit recheck)', async () => {
    const recheck = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: noPersonalConnections, compute,
      runtime: managerPersonalRuntime(config, db), tokens: runTokenIssuer(db, apiUrl), stopPollMs: 50, runtimeCaps: { idleSeconds: 5, wallClockSeconds: 10 },
      hooks: { afterDispatch: async () => { await pool.query(`UPDATE personal_run_enablements SET status = 'paused' WHERE owner_user_id = $1`, [owner.id]); } } });
    const started = await ask();
    assert.equal(await recheck.process(started.run.id), 'paused');
    assert.equal((await row(started.run.id)).answer_body, null);
    await pool.query(`UPDATE personal_run_enablements SET status = 'active' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('no local tool remains: an extra tool or MCP server in system/init stops the run with no answer', async () => {
    for (const name of ['run_extra_tool', 'run_extra_server']) {
      await resetFake();
      await scenario(name);
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'unavailable', name);
      const stored = await row(started.run.id);
      assert.deepEqual([stored.end_reason, stored.answer_body], ['local_tool', null], name);
    }
  });

  test('expired login, plan limit, both timeouts, crash, oversized output and a broken stream each end in their own state; none falls back to an API key', async () => {
    const expected: [string, string, string][] = [
      ['run_expired_login', 'unavailable', 'sign_in_again'],
      ['run_plan_limit', 'unavailable', 'plan_limit'],
      ['run_hang', 'provider_failed', 'no_event'],
      ['run_slow', 'cap_reached', 'wall_clock'],
      ['run_crash', 'provider_failed', 'crashed'],
      ['run_big_answer', 'cap_reached', 'answer_too_large'],
      ['run_broken_stream', 'provider_failed', 'unknown'],
      ['run_max_turns', 'cap_reached', 'max_turns'],
      ['run_model_unavailable', 'unavailable', 'model_unavailable'],
    ];
    for (const [name, status, reason] of expected) {
      await resetFake();
      await scenario(name);
      const started = await ask();
      assert.equal(await processor.process(started.run.id), status, name);
      const stored = await row(started.run.id);
      assert.deepEqual([stored.end_reason, stored.answer_body], [reason, null], name);
      if (name === 'run_plan_limit') assert.equal((stored.plan_limit_resets_at as Date).toISOString(), new Date(1791374400 * 1000).toISOString());
      // Never rerun: the run is final and no second CLI start was recorded for it.
      assert.equal((await calls()).filter((entry) => entry.event === 'run').length, 1, name);
    }
    assert.equal(compute.dispatched.length, 0, 'no API key request was ever made');
  });

  test('tool results past the route\'s bound end the run in its own state', async () => {
    // A run's pages stay under the 16 KiB per-call bound (#484), so the run total (64 KiB) is what a long read passes.
    const read = { name: 'flux_get_doc', args: { projectId: place.id, id: bigDocId } };
    await script({ calls: Array.from({ length: 10 }, () => read), answer: 'read it' });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body], ['mcp_results_too_large', null]);
    const results = (await calls()).filter((entry) => entry.event === 'tool_result') as { isError: boolean; text: string }[];
    assert.ok(results.length >= 2 && !results[0]!.isError, 'earlier pages were returned');
    const refused = results.find((entry) => entry.isError);
    if (refused) assert.ok(!refused.text.includes('log line. log line.'), 'the over-budget result was not returned');
    assert.ok(results.filter((entry) => !entry.isError).reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) <= 64 * 1024, 'the CLI never received more than the per-run total');
    assert.ok(results.every((entry) => Buffer.byteLength(entry.text) <= 16 * 1024), 'no single result passed the call bound');
  });

  test('Stop records requested and acknowledged separately; SIGINT, then SIGTERM for a CLI that ignores it', async () => {
    for (const name of ['run_slow', 'run_ignore_sigint']) {
      await resetFake();
      await scenario(name);
      const started = await ask();
      const processing = processor.process(started.run.id);
      await waitFor(async () => (await calls()).some((entry) => entry.event === 'tools_list'), 'the CLI started');
      await runs.stop(human(owner), started.run.id);
      assert.ok((await row(started.run.id)).stop_requested_at, 'requested');
      assert.equal(await processing, 'stopped', name);
      const stored = await row(started.run.id);
      assert.ok(stored.stop_acknowledged_at, `${name}: acknowledged by the slot`);
      assert.equal(stored.answer_body, null);
    }
  });

  test('a second concurrent run: refused while one is in flight; a busy slot ends a run as slot_busy', async () => {
    const first = await ask();
    // F-027 A4: one request may wait behind the working one; a third is refused.
    const behind = await ask();
    assert.equal(behind.run.status, 'queued');
    await assert.rejects(ask(), (error: unknown) => (error as { code?: string }).code === 'PERSONAL_RUN_IN_FLIGHT');
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [behind.run.id]);
    // The slot's lane is serial (sign-in, status, run and sign-out never overlap): a sign-out that is still
    // running makes the run busy at once; it never waits in the lane.
    await scenario('logout_hangs');
    const target = { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret };
    const holding = callSupervisor(target, { kind: 'logout', bindingId, client: 'claude_code', bootId: slot.config.bootId } satisfies SupervisorRequest);
    await waitFor(async () => (await calls()).some((entry) => Array.isArray(entry.argv) && (entry.argv as string[]).join(' ') === 'auth logout'), 'the lane is held');
    assert.equal(await processor.process(first.run.id), 'unavailable');
    assert.equal((await row(first.run.id)).end_reason, 'slot_busy');
    await holding;
  });

  test('a token-shaped string or the run token itself in the CLI\'s output is redacted from the committed answer', async () => {
    await scenario('run_secret_answer');
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    const answer = String(stored.answer_body);
    assert.ok(answer.includes(REDACTED_SECRET));
    assert.doesNotMatch(answer, /sk-ant-|eyJ/);
    assert.equal(stored.answer_redacted, true);
    const everything = (await pool.query(`SELECT row_to_json(r)::text AS text FROM personal_runs r WHERE id = $1`, [started.run.id])).rows[0].text as string;
    assert.doesNotMatch(everything, /sk-ant-api03|eyJ[A-Za-z0-9_-]{10,}\./);
  });

  test('revoking the assistant connection mid-run makes the next MCP call fail with 403 and ends the run', async () => {
    await script({ calls: [{ name: 'flux_list_contexts' }, { name: 'flux_list_contexts' }], delayMs: 3_000, answer: 'done' });
    const started = await ask();
    const processing = processor.process(started.run.id);
    await waitFor(async () => (await calls()).some((entry) => entry.event === 'tool_result'), 'the first call');
    const assistant = await settings();
    expectStatus(await owner.browser.request('DELETE', `/api/v1/agent-connections/${assistant.connectionId}`), 204);
    assert.equal(await processing, 'revoked');
    assert.equal((await row(started.run.id)).answer_body, null);
    const results = (await calls()).filter((entry) => entry.event === 'tool_result') as { status: number }[];
    if (results.length > 1) assert.equal(results[1]!.status, 403, 'the next call was refused');
    // Turning the assistant on again revives its connection and switches (A1).
    await runs.remove(human(owner));
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUNTIME_CONSENT_VERSION, agentId, engine: 'runtime' });
  });

  async function setMode(approvalMode: 'act' | 'ask') {
    const current = await settings();
    if (current.approvalMode !== approvalMode)
      expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(ws.id, owner.id), { body: { approvalMode }, headers: { 'if-match': `"${current.version}"` } }), 200);
  }
  const changeRows = async (runId: string) => (await pool.query(`SELECT id, state, wait_reason, authority, receipt, prepared_command, version, decided_by FROM assistant_changes WHERE run_id = $1 ORDER BY created_at, id`, [runId])).rows as
    { id: string; state: string; wait_reason: string | null; authority: string | null; receipt: Record<string, unknown> | null; prepared_command: { tool: string; view?: string; args: Record<string, unknown> } | null; version: number; decided_by: string | null }[];

  test('F-027 A3 on the runtime engine: the fake CLI\'s change tool applies, "Ask me first" makes the same call wait, and an Apply long after commits once without starting the CLI again', async () => {
    const appliedCommand = randomUUID(); const waitingCommand = randomUUID();
    await script({ calls: [{ name: 'flux_create_task', args: { clientCommandId: appliedCommand, task: { title: 'Runtime task' } } }], answer: 'Done: added a task.' });
    const first = await ask('Add a task');
    assert.equal(await processor.process(first.run.id), 'completed');
    const [applied] = await changeRows(first.run.id);
    assert.deepEqual([applied!.state, applied!.authority], ['applied', 'owner_request']);
    assert.deepEqual([applied!.receipt!.engine, applied!.receipt!.payer, applied!.receipt!.runId, applied!.receipt!.ownerUserId], ['runtime', 'Your Claude plan', first.run.id, owner.id], 'owner, engine, payer label and run id');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Runtime task'`)).rows[0].n, 1);
    await setMode('ask');
    try {
      await resetFake();
      await script({ calls: [{ name: 'flux_create_task', args: { clientCommandId: waitingCommand, task: { title: 'Waits for the owner' } } }], answer: 'Asked first.' });
      const second = await ask('Add another task');
      assert.equal(await processor.process(second.run.id), 'completed');
      const result = (await calls()).find((entry) => entry.event === 'tool_result' && entry.name === 'flux_create_task') as { isError: boolean; text: string };
      assert.ok(!result.isError && /^Waiting for rt-run-owner's OK: add task Waits for the owner\.$/.test(result.text), result.text);
      const [waiting] = await changeRows(second.run.id);
      assert.deepEqual([waiting!.state, waiting!.wait_reason], ['waiting', 'ask']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Waits for the owner'`)).rows[0].n, 0);
      const cliCalls = (await calls()).length;
      const dispatched = compute.dispatched.length;
      expectStatus(await owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: { expectedVersion: waiting!.version } }), 200);
      const [after] = await changeRows(second.run.id);
      assert.deepEqual([after!.state, after!.authority, after!.decided_by, after!.receipt!.engine], ['applied_after_wait', 'owner_approval', owner.id, 'runtime']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Waits for the owner'`)).rows[0].n, 1);
      assert.equal((await calls()).length, cliCalls, 'Apply started no CLI');
      assert.equal(compute.dispatched.length, dispatched, 'and no provider');
      assert.equal((await row(second.run.id)).status, 'completed', 'the source run is not revived');
    } finally { await setMode('act'); }
  });

  test('F-027 A3 on the runtime engine: a hand-off to the owner\'s own agent is prepared as the same private intent as on the server engine, and Apply opens one pending unit', async () => {
    const codexAgent = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada Codex', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: codexAgent }, role: 'contributor' } }), 201);
    const codex = await agentConnection(pool, owner.browser, codexAgent, [place.id]);
    const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Runtime hand-off' } }), 201) as { id: string; version: number };
    await setMode('ask');
    try {
      const input = { clientCommandId: randomUUID(), peerRequestClass: 'review', taskId: task.id, unitKey: 'runtime', expectedTaskVersion: task.version, assignmentConnectionId: codex.connectionId, parent: null };
      await script({ calls: [{ name: 'flux_create_unit', args: input }], answer: 'Asked first.' });
      const started = await ask('Ask my Codex to review it');
      assert.equal(await processor.process(started.run.id), 'completed');
      const [prepared] = await changeRows(started.run.id);
      assert.deepEqual([prepared!.state, prepared!.prepared_command!.tool, prepared!.prepared_command!.view], ['waiting', 'flux_create_unit', ASSISTANT_UNIT_CREATE_VIEW]);
      assert.deepEqual({ ...prepared!.prepared_command!.args }, { ...input, projectId: place.id }, 'the same intent the server engine stores');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM cowork_units WHERE work_id = $1`, [task.id])).rows[0].n, 0, 'proposed, not created');
      const cliCalls = (await calls()).length;
      expectStatus(await owner.browser.request('POST', assistantChangeActionPath(prepared!.id, 'apply'), { body: {} }), 200);
      const unit = (await pool.query(`SELECT state, generation, role, assignment_connection_id FROM cowork_units WHERE work_id = $1`, [task.id])).rows;
      assert.deepEqual(unit, [{ state: 'pending', generation: 0, role: 'review', assignment_connection_id: codex.connectionId }]);
      assert.equal((await calls()).length, cliCalls, 'Apply started no CLI');
    } finally { await setMode('act'); }
  });

  test('AST-4.2 (read part) and AST-4.4 on the runtime: an Off Wiki lists no Wiki tool and gets the S6 refusal, also mid-run', async () => {
    await setWiki('off');
    await script({ calls: [{ name: 'flux_list_contexts' }], probes: [{ name: 'flux_get_doc', args: { projectId: place.id, id: docId } }], answer: 'ok' });
    let started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    let recorded = await calls();
    const listed = recorded.find((entry) => entry.event === 'tools_list') as { tools: string[] };
    assert.ok(!listed.tools.some((tool) => ['flux_get_doc', 'flux_list_docs', 'flux_list_materials', 'flux_read_material'].includes(tool)), 'no Wiki tool');
    const probe = recorded.find((entry) => entry.event === 'tool_result' && entry.name === 'flux_get_doc') as { isError: boolean; text: string };
    assert.ok(probe.isError && probe.text.includes('MCP_ENTRY_UNAVAILABLE') && !probe.text.includes(WIKI_CANARY), 'the S6 refusal');
    // Mid-run: the Wiki is on at the start, then turned off; the same token's next Wiki read is refused.
    await setWiki('edit');
    await resetFake();
    await script({ calls: [{ name: 'flux_get_doc', args: { projectId: place.id, id: docId } }, { name: 'flux_get_doc', args: { projectId: place.id, id: docId } }], delayMs: 3_000, answer: 'ok' });
    started = await ask();
    const processing = processor.process(started.run.id);
    await waitFor(async () => (await calls()).some((entry) => entry.event === 'tool_result'), 'the first Wiki read');
    await setWiki('off');
    await processing;
    recorded = await calls();
    const reads = recorded.filter((entry) => entry.event === 'tool_result') as { isError: boolean; text: string }[];
    assert.ok(reads[0]!.text.includes(WIKI_CANARY), 'the first read was allowed');
    assert.ok(reads[1]!.isError && reads[1]!.text.includes('MCP_ENTRY_UNAVAILABLE') && !reads[1]!.text.includes(WIKI_CANARY), 'the next read is refused');
  });

  test('runs per day: the 21st request of the day is refused and the assistant shows it is at its daily limit; no API key is used', async () => {
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    // Nineteen more started today, as copies of that one (each started and ended).
    await pool.query(`INSERT INTO personal_runs (id, workspace_id, project_id, conversation_id, owner_user_id, agent_id, client_run_id, request_fingerprint, kind,
        prompt, status, cost_state, reserved_micros, provider, model, engine, dispatched_at, completed_at)
      SELECT gen_random_uuid(), workspace_id, project_id, conversation_id, owner_user_id, agent_id, gen_random_uuid(), request_fingerprint, kind, prompt,
        'completed', 'unknown', 0, provider, model, engine, now(), now() FROM personal_runs, generate_series(1, 19) WHERE id = $1`, [started.run.id]);
    assert.equal((await runs.status(human(owner))).state, 'capped');
    await assert.rejects(ask(), (error: unknown) => (error as { code?: string }).code === 'PERSONAL_RUN_CAPPED');
    assert.equal(compute.dispatched.length, 0);
  });

  test('AST-9.1 on the runtime: a DM, a private map and another project never reach the CLI\'s MCP results', async () => {
    await script({ calls: [
      { name: 'flux_search_project', args: { projectId: place.id, q: 'canary', type: 'message' } },
      { name: 'flux_list_maps', args: { projectId: place.id } },
      { name: 'flux_get_doc', args: { projectId: other.id, id: otherDocId } },
      { name: 'flux_list_contexts' },
    ], answer: '{{results}}' });
    const started = await ask('Find the canary');
    assert.equal(await processor.process(started.run.id), 'completed');
    const everything = JSON.stringify(await calls()) + String((await row(started.run.id)).answer_body);
    for (const canary of [DM_CANARY, PRIVATE_CANARY, OTHER_CANARY]) assert.ok(!everything.includes(canary), canary);
  });

  test('AST-11: the chosen model reaches the CLI as --model; a change applies to the next request only; a legacy assistant starts with no flag; a model outside the list is refused', async () => {
    const argvOf = async () => ((await calls()).find((entry) => entry.event === 'run') as { argv: string[] }).argv;
    const flag = (argv: string[]) => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null);
    await script({ calls: [], answer: 'Done.' });
    // Turned on with no model named: the account's own default, no flag, recorded as before (AST-11).
    let choice = await runs.model(human(owner));
    assert.deepEqual([choice.engine, choice.account, choice.company, choice.current, choice.saved], ['runtime', 'claude_plan', 'Claude', 'default', true]);
    assert.deepEqual(choice.options.map((option) => option.id), ['default', 'sonnet', 'opus', 'haiku']);
    const legacy = await ask();
    assert.equal(await processor.process(legacy.run.id), 'completed');
    assert.equal(flag(await argvOf()), null, 'no model flag for a legacy assistant');
    assert.equal((await row(legacy.run.id)).model, 'claude-code');

    // Choosing Opus changes the next request.
    choice = await runs.chooseModel(human(owner), { model: 'opus' });
    assert.deepEqual([choice.current, choice.options.map((option) => option.id)], ['opus', ['sonnet', 'opus', 'haiku']], 'the default row is gone after a pick');
    const early = await ask();
    // A change made after it was sent never reaches it; the next request is sent with the new model.
    await runs.chooseModel(human(owner), { model: 'haiku' });
    const late = await ask();
    await resetFake(); await script({ calls: [], answer: 'Done.' });
    assert.equal(await processor.process(early.run.id), 'completed');
    assert.equal(flag(await argvOf()), 'opus', 'the request sent under Opus keeps Opus');
    await resetFake(); await script({ calls: [], answer: 'Done.' });
    assert.equal(await processor.process(late.run.id), 'completed');
    assert.equal(flag(await argvOf()), 'haiku');
    assert.deepEqual([(await row(early.run.id)).model, (await row(late.run.id)).model], ['opus', 'haiku'], 'each run records its model');
    assert.equal(((await runs.get(human(owner), early.run.id)).model), 'opus');

    // Anything outside the account's list is a plain error and the previous model stays; nothing is passed to a command.
    for (const bad of ['fable', 'gpt-6.1-sol', 'default', '--dangerously-skip-permissions', 'opus;id', '', 42]) {
      await assert.rejects(runs.chooseModel(human(owner), { model: bad as string }), (error: unknown) => (error as { code?: string }).code === 'ASSISTANT_MODEL_UNAVAILABLE'
        && (error as Error).message === 'Your Claude plan doesn\'t offer that model. It is still Haiku.', String(bad));
    }
    assert.equal((await runs.model(human(owner))).current, 'haiku');
  });

  test('AST-11: a model the vendor does not accept ends the run as its own state; the setting stays and nothing falls back', async () => {
    await runs.chooseModel(human(owner), { model: 'opus' });
    await scenario('run_model_unavailable');
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'unavailable');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.end_reason, stored.answer_body, stored.model], ['model_unavailable', null, 'opus']);
    assert.equal((await runs.get(human(owner), started.run.id)).endReason, 'model_unavailable');
    assert.equal((await runs.model(human(owner))).current, 'opus', 'the setting stays');
    assert.equal((await calls()).filter((entry) => entry.event === 'run').length, 1, 'no other model was tried');
    assert.equal(compute.dispatched.length, 0);
  });
});
