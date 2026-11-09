import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import {
  AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH, assistantRunPath,
  conversationAssistantRunsPath, MY_AGENTS_PATH, taskAgentPath, workItemPath, type AgentRuntimeConsoleServerMessage, type AgentRuntimeStatus,
  type AssistantRun, type TaskAgentState, type WorkItem,
} from '@flux/contracts';
import { createDatabase } from '@flux/db';
import type { CliJournalEntry, CliStep } from './support/cli-vendor-mock.js';
import { apiUrl, publicOrigin, signIn } from './support/http.js';
import { addMember, expectStatus, password, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';

// TEST ONLY (#1125): the API side of scripts/check_cli_runtime.sh. The stack runs the REAL pinned Claude Code and Codex in the
// runtime image against the vendor mock of providermock (support/cli-vendor-mock.ts). Each step sets what "the model" does, starts
// a run through Flux's API and asserts what Flux did: the run's row, its tools and MCP results, the changes, web reads and searches,
// the connection's state and the mock's journal. Never the model's text. One step per call; people are kept in /state between
// steps, and steps print KEY=value lines for the script.

const stateFile = `${process.env.FLUX_TEST_STATE_DIR ?? '/state'}/cli-runtime.json`;
interface State {
  people: Record<string, { email: string; id: string }>;
  workspaceId?: string; projectId?: string; conversationId?: string; agents?: Record<string, string>;
}
const load = async (): Promise<State> => ({ people: {}, ...JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as Partial<State> });
const save = async (state: State) => writeFile(stateFile, JSON.stringify(state));
const { pool } = createDatabase(process.env.DATABASE_URL!);
const mockUrl = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const CONVERSATION_TEXT = 'Camera fails below 5 lux';
/** Pages of linkmock, which the API reaches as public.test (FLUX_TEST_LINK_PREVIEW_HOSTS). */
const PAGE = { second: 'http://public.test/read/second', notes: 'http://public.test/read/notes' } as const;

async function owner(label: string): Promise<Person> {
  const state = await load();
  const known = state.people[label];
  if (known) {
    const { browser, response } = await signIn(known.email, password);
    assert.equal(response.status, 200, `${label} signs in`);
    return { id: known.id, email: known.email, browser };
  }
  const created = await person(`CLI ${label}`);
  state.people[label] = { email: created.email, id: created.id };
  await save(state);
  return created;
}

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, seconds = 120): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(500);
    value = await read();
  }
  return value;
}

async function mock(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${mockUrl}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}
const script = (client: 'claude' | 'codex', steps: CliStep[], extra: Record<string, unknown> = {}) => mock('/__cli/script', { client, steps, ...extra });
const journal = async () => ((await mock('/__cli/journal')) as { journal: CliJournalEntry[] }).journal;
const journalSince = async (n: number) => (await journal()).filter((entry) => entry.n > n);
const lastEntry = async () => (await journal()).at(-1)?.n ?? 0;

const runtimeStatus = async (someone: Person) => expectStatus(await someone.browser.request('GET', AGENT_RUNTIME_PATH), 200) as AgentRuntimeStatus;

interface RunRow {
  id: string; status: string; engine: string; end_reason: string | null; run_tools: string[]; mcp_result_bytes: number; answer_body: string | null;
  plan_limit_resets_at: Date | null; kind: string; model: string;
}
const runRow = async (id: string) => (await pool.query<RunRow>(`SELECT id, status, engine, end_reason, run_tools, mcp_result_bytes, answer_body,
  plan_limit_resets_at, kind, model FROM personal_runs WHERE id = $1`, [id])).rows[0]!;

/** Starts `/ai` in the space's conversation and waits until the run has ended. */
async function askAi(someone: Person, conversationId: string, prompt: string): Promise<AssistantRun> {
  const started = expectStatus(await someone.browser.request('POST', conversationAssistantRunsPath(conversationId),
    { body: { clientRunId: randomUUID(), kind: 'ask', prompt } }), 202) as AssistantRun;
  assert.equal(started.engine, 'runtime', 'the run goes to the owner\'s own CLI in the runtime');
  return until('the run to end', async () => expectStatus(await someone.browser.request('GET', assistantRunPath(started.id)), 200) as AssistantRun,
    (run) => !['queued', 'reading', 'dispatching'].includes(run.status), 240);
}

const mainRequests = (entries: CliJournalEntry[], client: 'claude' | 'codex') => entries.filter((entry) => entry.client === client && entry.kind === 'main');
function print(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) console.log(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`); }

/** One console attach: Codex's device sign-in, approved at the mock issuer once the CLI printed its code (the person approved it). */
function deviceSignIn(someone: Person, ticket: string): Promise<{ messages: AgentRuntimeConsoleServerMessage[]; output: string; code: number }> {
  const socket = new WebSocket(`${apiUrl.replace(/^http/, 'ws')}${AGENT_RUNTIME_CONSOLE_PATH}`, { headers: { origin: publicOrigin, cookie: someone.browser.cookieHeader() } });
  const run = { messages: [] as AgentRuntimeConsoleServerMessage[], output: '', code: 0 };
  let approved = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`console timed out: ${JSON.stringify(run.messages)} ${JSON.stringify(run.output.slice(-600))}`)); }, 90_000);
    socket.on('open', () => socket.send(JSON.stringify({ t: 'attach', ticket, cols: 100, rows: 30 })));
    socket.on('message', (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString()) as AgentRuntimeConsoleServerMessage;
        run.messages.push(message);
        if (message.t === 'done') socket.close(1000, 'done');
        return;
      }
      run.output += data.toString();
      if (!approved && /[A-Z0-9]{4,8}-[A-Z0-9]{4,8}/.test(run.output) && run.output.includes('cancel.')) {
        approved = true;
        void mock('/__cli/approve', {}).catch(reject);
      }
    });
    socket.on('close', (code) => { clearTimeout(timer); run.code = code; resolve(run); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const steps: Record<string, (...args: string[]) => Promise<void>> = {
  /** The runtime is up with both clients, and its supervisor reported to the worker. */
  async 'wait-ready'() {
    await until('a ready runtime', async () => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_runtime_slots WHERE state = 'ready'`)).rows[0]!.n,
      (n) => n >= 1, 180);
    const watcher = await owner('watcher');
    const on = await runtimeStatus(watcher);
    assert.equal(on.enabled, true);
    assert.deepEqual(on.clients, { claude_code: 'available', codex: 'available' });
    print({ READY: true });
  },

  /** Ada (Claude Code) and Bo (Codex) in one company, a space with a conversation, an agent each, and a place in the runtime. */
  async setup() {
    const ada = await owner('ada');
    const bo = await owner('bo');
    const ws = await createWorkspace(ada, 'Lamp works');
    await addMember(ada, ws.id, bo, 'member');
    const space = await createProject(ada, ws.id, 'Lamp sensor', 'workspace');
    const thread = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${space.id}/conversations`,
      { body: { body: CONVERSATION_TEXT, clientMessageId: randomUUID() } }), 201) as { id: string };
    const agents: Record<string, string> = {};
    const out: Record<string, string> = {};
    for (const [label, someone] of [['ada', ada], ['bo', bo]] as const) {
      agents[label] = (expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
      expectStatus(await someone.browser.request('POST', AGENT_RUNTIME_BINDING_PATH), 200);
      const { rows } = await pool.query<{ id: string; slot: string }>(`SELECT id, slot FROM agent_runtime_bindings WHERE owner_user_id = $1 AND state = 'active'`, [someone.id]);
      out[`${label.toUpperCase()}_BINDING`] = rows[0]!.id;
      out.SLOT = rows[0]!.slot;
    }
    await save({ ...await load(), workspaceId: ws.id, projectId: space.id, conversationId: thread.id, agents });
    print(out);
  },

  /**
   * Ada is signed in to Claude Code with an API key (the script wrote it into her CLI home; a plan sign-in cannot be faked): Flux reads
   * that from `claude auth status` only, and her agent runs on Claude Code.
   */
  async 'claude-check'() {
    const ada = await owner('ada');
    const checked = expectStatus(await ada.browser.request('POST', AGENT_RUNTIME_CHECK_PATH, { body: { client: 'claude_code' } }), 200) as AgentRuntimeStatus;
    const connection = checked.connections.claude_code;
    assert.equal(connection?.state, 'signed_in', JSON.stringify(checked));
    assert.equal(connection?.authMethod, 'api_key');
    assert.equal(connection?.payer, 'anthropic_console', 'an API key is billed to the Console organization (RT-8)');
    const { agents } = await load();
    const mine = expectStatus(await ada.browser.request('GET', MY_AGENTS_PATH), 200) as { items: { id: string }[] };
    if (!mine.items.some((item) => item.id === agents!.ada)) {
      expectStatus(await ada.browser.request('POST', MY_AGENTS_PATH, { body: { agentId: agents!.ada, connection: 'claude_plan', model: 'sonnet' } }), 201);
    }
    print({ CLAUDE: connection?.state, PAYER: connection?.payer });
  },

  /**
   * `/ai` on Claude Code: the model reads the conversation, creates a task and reads a page the request named, through Flux's MCP
   * route with the run token. Flux records the tools, the MCP result bytes, the change with its Undo row and the web read, and
   * commits the answer.
   */
  async 'claude-ai'() {
    const ada = await owner('ada');
    const { projectId, conversationId } = await load();
    const title = `Check the camera below 5 lux ${randomUUID().slice(0, 6)}`;
    await script('claude', [
      { tool: 'flux_get_conversation', args: { projectId, id: conversationId } },
      { tool: 'flux_create_task', args: { projectId, clientCommandId: randomUUID(), task: { title } } },
      { tool: 'flux_read_web', args: { url: PAGE.second } },
      { text: 'Done: I read the thread and the page, and made a task.' },
    ]);
    const from = await lastEntry();
    const run = await askAi(ada, conversationId!, `Summarise this thread, make a task to check the camera, and read ${PAGE.second}`);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.runtimeClient, 'claude_code');
    const row = await runRow(run.id);
    assert.deepEqual([row.engine, row.status, row.end_reason], ['runtime', 'completed', null]);
    for (const tool of ['flux_get_conversation', 'flux_create_task', 'flux_read_web']) assert.ok(row.run_tools.includes(tool), `the run token granted ${tool}: ${row.run_tools.join(',')}`);
    assert.ok(row.mcp_result_bytes > 0, 'Flux counted the MCP results it sent');
    assert.ok(row.answer_body, 'the answer is committed');
    // The change: an applied row in the change log for the task the model created, and the task itself.
    const changes = await pool.query<{ state: string; object_type: string; object_id: string }>(`SELECT state, object_type, object_id FROM assistant_changes WHERE run_id = $1`, [run.id]);
    assert.deepEqual(changes.rows.map((change) => [change.state, change.object_type]), [['applied', 'work']], JSON.stringify(changes.rows));
    const task = await pool.query<{ title: string; project_id: string }>(`SELECT title, project_id FROM project_work_items WHERE id = $1`, [changes.rows[0]!.object_id]);
    assert.deepEqual(task.rows[0], { title, project_id: projectId });
    const reads = await pool.query<{ url: string; outcome: string }>(`SELECT url, outcome FROM personal_run_web_reads WHERE run_id = $1`, [run.id]);
    assert.deepEqual(reads.rows, [{ url: PAGE.second, outcome: 'read' }]);
    // The mock: the model was offered Flux's tools and got Flux's real answers back (the conversation, the task, the page).
    const main = mainRequests(await journalSince(from), 'claude');
    assert.equal(main.length, 4, `four model turns: ${JSON.stringify(main.map((entry) => entry.step))}`);
    assert.ok(main[0]!.tools!.includes('mcp__flux__flux_get_conversation') && !main[0]!.tools!.includes('WebFetch'), JSON.stringify(main[0]!.tools));
    const results = main.at(-1)!.results!;
    assert.equal(results.length, 3);
    assert.ok(results[0]!.includes(CONVERSATION_TEXT), `the conversation came back: ${results[0]!.slice(0, 300)}`);
    assert.ok(results[1]!.includes(changes.rows[0]!.object_id), `the created task's receipt came back: ${results[1]!.slice(0, 300)}`);
    assert.ok(results[2]!.includes('Another page with its own words'), `the page came back: ${results[2]!.slice(0, 300)}`);
    print({ CLAUDE_AI_RUN: run.id, TOOLS: row.run_tools.length, MCP_BYTES: row.mcp_result_bytes });
  },

  /**
   * Claude Code's own `WebSearch` (#1065, C-30): the slot reports the search when the CLI starts it and its result addresses when they
   * come back; Flux writes them to the run, and `flux_read_web` reads one of them.
   */
  async 'claude-search'() {
    const ada = await owner('ada');
    const { conversationId } = await load();
    const query = 'camera low light lux threshold';
    await script('claude', [
      { search: { query, results: [{ url: PAGE.second, title: 'Second page' }, { url: PAGE.notes, title: 'Notes' }], text: 'Two pages.' } },
      { tool: 'flux_read_web', args: { url: PAGE.notes } },
      { text: 'Done: I searched and read one result.' },
    ]);
    const from = await lastEntry();
    const run = await askAi(ada, conversationId!, 'Search the web for the camera\'s low light threshold.');
    assert.equal(run.status, 'completed', JSON.stringify(run));
    const searches = await pool.query<{ queries: string[]; results: string[]; pending: boolean }>(`SELECT queries, results, pending FROM personal_run_web_searches WHERE run_id = $1`, [run.id]);
    assert.deepEqual(searches.rows, [{ queries: [query], results: [PAGE.second, PAGE.notes], pending: false }], 'the search and its result addresses are the run\'s');
    const reads = await pool.query<{ url: string; outcome: string }>(`SELECT url, outcome FROM personal_run_web_reads WHERE run_id = $1`, [run.id]);
    assert.deepEqual(reads.rows, [{ url: PAGE.notes, outcome: 'read' }]);
    const entries = await journalSince(from);
    assert.ok(mainRequests(entries, 'claude')[0]!.tools!.includes('WebSearch'), 'the CLI kept its own WebSearch');
    assert.equal(entries.filter((entry) => entry.kind === 'web_search').length, 1, 'the CLI ran the search through the Messages API');
    print({ CLAUDE_SEARCH_RUN: run.id, RESULTS: searches.rows[0]!.results.length });
  },

  /**
   * An agent task run on Claude Code: Ada gives a task to her agent; the worker runs it in the runtime, the model reads the task's
   * discussion and makes a subtask, and the agent's report lands in the task's discussion.
   */
  async 'claude-task'() {
    const ada = await owner('ada');
    const { projectId, agents } = await load();
    const parent = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/work`,
      { body: { title: 'Find out why the camera fails in the dark' } }), 201) as WorkItem;
    const subtask = `Measure lux at the door ${randomUUID().slice(0, 6)}`;
    await script('claude', [
      { tool: 'flux_get_task_discussion', args: { taskId: parent.id } },
      { tool: 'flux_create_task', args: { projectId, clientCommandId: randomUUID(), task: { title: subtask, parentTaskId: parent.id } } },
      { text: 'I made a subtask to measure the light at the door.' },
    ]);
    const from = await lastEntry();
    // Only now does Ada give it to her agent (the Owner field): the run may start at once, and the script is already set.
    expectStatus(await ada.browser.request('PATCH', workItemPath(parent.id), { body: { owner: { kind: 'agent', id: agents!.ada } }, headers: { 'if-match': `"${parent.version}"` } }), 200);
    const line = await until('the agent to finish the task', async () => expectStatus(await ada.browser.request('GET', taskAgentPath(parent.id)), 200) as TaskAgentState,
      (state) => state.line !== null && !['waiting_for_room', 'working'].includes(state.line), 240);
    assert.ok(line.runId, JSON.stringify(line));
    const row = await runRow(line.runId);
    assert.deepEqual([row.kind, row.engine, row.status], ['task', 'runtime', 'completed'], JSON.stringify(row));
    assert.ok(['done', 'handed_back'].includes(line.line!), `the task's line: ${line.line} (${line.text})`);
    // The changes of the run: the subtask the model made, and the agent's report in the task's discussion (posted by Flux, as the agent).
    const changes = await pool.query<{ state: string; object_type: string; object_id: string; tool: string }>(
      `SELECT state, object_type, object_id, tool FROM assistant_changes WHERE run_id = $1 ORDER BY created_at, id`, [row.id]);
    const made = changes.rows.find((change) => change.tool === 'flux_create_task');
    assert.ok(made && made.state === 'applied' && made.object_type === 'work', JSON.stringify(changes.rows));
    assert.ok(changes.rows.some((change) => change.object_type === 'message' && change.state === 'applied'), `the agent's report: ${JSON.stringify(changes.rows)}`);
    const child = await pool.query<{ title: string }>(`SELECT w.title FROM project_object_links l JOIN project_work_items w ON w.id = l.from_id
      WHERE l.role = 'part_of' AND l.to_type = 'work' AND l.to_id = $1 AND l.from_id = $2`, [parent.id, made.object_id]);
    assert.deepEqual(child.rows, [{ title: subtask }], 'the subtask is part of the task');
    const main = mainRequests(await journalSince(from), 'claude');
    assert.ok(main[0]!.tools!.includes('mcp__flux__flux_get_task_discussion'), JSON.stringify(main[0]!.tools));
    assert.ok(main.at(-1)!.results!.some((result) => result.includes(made.object_id)), 'the created subtask\'s receipt came back to the model');
    print({ CLAUDE_TASK_RUN: row.id, TASK_LINE: line.line });
  },

  /**
   * The CLI's own error texts, from the API errors the mock returns: what Flux records for the run. `rate_limit` is a 429 of the
   * Messages API, `context` the API's "prompt is too long". Expected reasons are what Flux does today (#1129).
   */
  async 'claude-error'(kind, expected) {
    const ada = await owner('ada');
    const { conversationId } = await load();
    const errors: Record<string, CliStep> = {
      rate_limit: { error: { status: 429, headers: { 'retry-after': '60', 'x-should-retry': 'false' },
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } } } },
      context: { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250123 tokens > 200000 maximum' } } } },
    };
    await script('claude', [errors[kind!]!]);
    const run = await askAi(ada, conversationId!, 'What is the camera\'s lux threshold?');
    const row = await runRow(run.id);
    assert.equal(row.answer_body, null, 'nothing is committed');
    assert.equal(row.end_reason, expected, `${kind}: Flux recorded ${row.status}/${row.end_reason}`);
    assert.equal((await runtimeStatus(ada)).connections.claude_code?.state, 'signed_in', 'the sign-in is untouched');
    print({ KIND: kind, STATUS: row.status, END_REASON: row.end_reason });
  },

  /**
   * Ada's key was revoked (the script wrote a refused one): the run ends "sign in again" for her to see. Her sign-in in Settings stays
   * "signed in" today, since the CLI's own status still reports the key (#1129); the step fails when that changes.
   */
  async 'claude-expired'() {
    const ada = await owner('ada');
    const { conversationId } = await load();
    await script('claude', [{ text: 'never reached' }]);
    const from = await lastEntry();
    const run = await askAi(ada, conversationId!, 'What is the camera\'s lux threshold?');
    const row = await runRow(run.id);
    assert.equal(row.end_reason, 'sign_in_again', JSON.stringify(row));
    assert.equal(run.endReason, 'sign_in_again', 'the owner sees why');
    assert.equal(row.answer_body, null);
    assert.ok((await journalSince(from)).some((entry) => entry.kind === 'refused_key'), 'the API refused the key');
    const view = await runtimeStatus(ada);
    assert.equal(view.connections.claude_code?.state, 'signed_in', 'today Settings still says signed in');
    print({ END_REASON: row.end_reason, CLAUDE: view.connections.claude_code?.state });
  },

  /** Codex's ChatGPT device sign-in through Flux's console, against the mock issuer: device code, approval, code exchange, status. */
  async 'codex-sign-in'() {
    const bo = await owner('bo');
    const from = await lastEntry();
    await script('codex', [], { accessLifetimeSeconds: 120 });
    const ticket = (expectStatus(await bo.browser.request('POST', AGENT_RUNTIME_CONSOLE_PATH, { body: { client: 'codex', method: 'device_code' } }), 200) as { ticket: string }).ticket;
    const run = await deviceSignIn(bo, ticket);
    const done = run.messages.at(-1);
    assert.ok(done?.t === 'done' && done.signedIn, JSON.stringify(run.messages));
    // Flux draws its device card only for OpenAI's own page (DEVICE_URL); the mock issuer's page is shown in the terminal only.
    assert.equal(run.messages.filter((message) => message.t === 'device').length, 0, 'no card for a page that is not OpenAI\'s');
    assert.ok(run.output.includes('/cli/auth/codex/device'), 'the CLI printed the issuer\'s device page');
    const issuer = (await journalSince(from)).filter((entry) => entry.client === 'issuer').map((entry) => entry.kind);
    assert.deepEqual(issuer, ['usercode', 'device_approved', 'code_exchange'], JSON.stringify(issuer));
    const status = await runtimeStatus(bo);
    assert.equal(status.connections.codex?.state, 'signed_in');
    assert.equal(status.connections.codex?.payer, 'chatgpt_plan');
    const { agents } = await load();
    expectStatus(await bo.browser.request('POST', MY_AGENTS_PATH, { body: { agentId: agents!.bo, connection: 'chatgpt_plan', model: 'gpt-6.1-sol' } }), 201);
    print({ CODEX: status.connections.codex?.state, PAYER: status.connections.codex?.payer });
  },

  /**
   * `/ai` on Codex. Today the real pinned Codex offers the model no Flux tool and its first JSONL item is an `error` ("Code Mode is
   * unavailable…": every model Flux offers is `code_mode_only` in its catalog), so Flux stops it as a local tool with nothing committed
   * (#1127). This step asserts that, so it fails, and must be rewritten, once #1127 is fixed.
   */
  async 'codex-ai'() {
    const bo = await owner('bo');
    const { conversationId, projectId } = await load();
    await script('codex', [
      { tool: 'flux_get_conversation', args: { projectId, id: conversationId } },
      { text: 'Done.' },
    ], { accessLifetimeSeconds: 3600 });
    const run = await askAi(bo, conversationId!, 'Summarise this thread.');
    assert.equal(run.runtimeClient, 'codex');
    const row = await runRow(run.id);
    assert.deepEqual([row.engine, row.end_reason, row.mcp_result_bytes, row.answer_body], ['runtime', 'local_tool', 0, null], `#1127: ${JSON.stringify(row)}`);
    print({ CODEX_AI_RUN: run.id, STATUS: row.status, END_REASON: row.end_reason, KNOWN: '#1127' });
  },

  /** Sign-out runs Codex's own logout, which revokes the token at the issuer, and Flux deletes the login. */
  async 'codex-sign-out'() {
    const bo = await owner('bo');
    const from = await lastEntry();
    const answer = expectStatus(await bo.browser.request('POST', AGENT_RUNTIME_SIGN_OUT_PATH, { body: { client: 'codex' } }), 200) as AgentRuntimeStatus;
    assert.equal(answer.connections.codex?.state, 'signed_out');
    assert.equal(answer.connections.codex?.signOut?.failed, false);
    assert.ok((await journalSince(from)).some((entry) => entry.kind === 'revoke'), 'Codex revoked its token at the issuer');
    print({ CODEX: answer.connections.codex?.state });
  },

  /**
   * RT-7: no vendor credential the CLIs sent (Claude's API keys, Codex's ChatGPT tokens, as the mock saw them) is anywhere in Flux's
   * database. The script greps the service logs for the same values.
   */
  async 'no-secret'(...extra) {
    const seen = new Set<string>(extra.filter(Boolean));
    for (const entry of await journal()) if (entry.credential) seen.add(entry.credential);
    assert.ok(seen.size >= 2, `control: the mock saw credentials: ${seen.size}`);
    const { rows: tables } = await pool.query<{ schema: string; name: string }>(`SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`);
    const found: string[] = [];
    for (const { schema, name } of tables) for (const value of seen) {
      const { rows } = await pool.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM "${schema}"."${name}" x WHERE x::text LIKE $1) AS found`, [`%${value}%`]);
      if (rows[0]!.found) found.push(`${schema}.${name}`);
    }
    assert.deepEqual(found, [], 'a vendor credential is in the database');
    console.log(`CREDENTIALS=${[...seen].join(' ')}`);
    print({ SCANNED: seen.size, TABLES: tables.length });
  },

  /** What reached the mock in the whole check, by kind (the script prints it). */
  async summary() {
    const counts: Record<string, number> = {};
    const agents = new Set<string>();
    for (const entry of await journal()) {
      counts[`${entry.client}:${entry.kind}`] = (counts[`${entry.client}:${entry.kind}`] ?? 0) + 1;
      if (entry.agent && (entry.client === 'claude' || entry.client === 'codex')) agents.add(entry.agent.split(' ')[0]!);
    }
    print({ MOCK: counts, CLIENTS: [...agents].sort() });
  },
};

const [name, ...args] = process.argv.slice(2);
try {
  const step = steps[name ?? ''];
  if (!step) throw new Error(`unknown step ${name}; steps: ${Object.keys(steps).join(', ')}`);
  await step(...args);
} finally {
  await pool.end();
}
