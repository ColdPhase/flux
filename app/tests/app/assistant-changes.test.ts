import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  ASSISTANT_CHANGES_PATH, ASSISTANT_RUN_EFFECT_TOOLS, assistantChangeActionPath, assistantMessageHeader, assistantRunChangesPath, assistantRunChangesActionPath, assistantSettingsPath, conversationAssistantChangesPath,
  NEEDS_YOU_PATH, PERSONAL_RUN_CONSENT_VERSION, PERSONAL_RUN_LIMITS, personalRunTokenPath,
  type AssistantChange, type AssistantRunUndone, type AssistantSettings, type Conversation, type NeedsYouResponse, type Project, type Workspace,
} from '@flux/contracts';
import { createPersonalRunProcessor, recoverPersonalRuns, type PersonalComputeResult, type Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { assistantChangeUseCases } from '../../apps/server/src/assistant/changes.js';
import { needsYouUseCases } from '../../apps/server/src/needs-you/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { mcpToolHost } from '../../apps/worker/src/personal-runs/mcp-session.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { mcp } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';

// F-027 A3 (#403): the change log, run authority and "Ask me first". An assistant run's change tool goes
// through the real `/mcp` route with the run's own token (the `runtime` engine's path) and, for the
// combination table, through the worker's tool loop with a FAKE provider (the `server` engine's path).
// Every call is classified as applied, waiting, suggestion or refused and recorded in `assistant_changes`
// in the same transaction. Waiting changes are applied by the owner only, with every check repeated.
// No model, CLI or vendor account is used; the clock for expiry and Inbox is a fake one.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, toolTurns: PERSONAL_RUN_LIMITS.maxTurns });
const tokens = runTokenIssuer(db, apiUrl);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20,
  tools: mcpToolHost(tokens, `${apiUrl}/mcp`), tokens });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
type Message = Record<string, unknown> | null;
const result = (message: Message) => message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
const text = (message: Message) => result(message)?.content?.[0]?.text ?? '';
const refusalCode = (message: Message) => result(message)?.isError ? (JSON.parse(text(message)) as { code?: string }).code : undefined;
const DAY = 86_400_000;

interface ChangeRow { id: string; state: string; wait_reason: string | null; authority: string | null; operation: string; object_id: string | null;
  receipt: Record<string, unknown> | null; refusal: string | null; decided_by: string | null; version: number; run_id: string }
const changesOf = async (runId: string) => (await pool.query(`SELECT * FROM assistant_changes WHERE run_id = $1 ORDER BY created_at, id`, [runId])).rows as ChangeRow[];

describe('the assistant\'s change log, run authority and "Ask me first" (F-027 A3, #403)', () => {
  let owner: Person; let peer: Person; let outsider: Person; let ws: Workspace; let place: Project;
  let thread: Conversation; let agentId: string;
  /** Jonas's workspace, where Ada is a member: a project she may only read, and one she contributes to. */
  let jonasWs: Workspace; let shared: Project; let sharedThread: Conversation;

  const settings = async (workspaceId = ws.id) => expectStatus(await owner.browser.request('GET', assistantSettingsPath(workspaceId, owner.id)), 200) as unknown as AssistantSettings;
  async function save(body: Record<string, unknown>, workspaceId = ws.id) {
    const current = await settings(workspaceId);
    expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(workspaceId, owner.id), { body, headers: { 'if-match': `"${current.version}"` } }), 200);
  }
  /** A run moved to `reading` (as the worker's claim does), with its token minted. */
  async function liveRun(conversation = thread) {
    const started = await runs.invoke(human(owner), conversation.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy the project' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
    const nonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(started.run.id, sha256(nonce))), true);
    const response = await fetch(`${apiUrl}${personalRunTokenPath(started.run.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(response.status, 200);
    const minted = await response.json() as { token: string; tools: string[] };
    let id = 0;
    const call = (name: string, args: Record<string, unknown>) => mcp(minted.token, ++id, 'tools/call', { name, arguments: { clientCommandId: randomUUID(), ...args } });
    return { runId: started.run.id, token: minted.token, tools: minted.tools, call };
  }
  /** The run ends normally, its token closed and expired: provenance only. */
  const complete = (runId: string) => pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'Done',
    cost_state = 'released', charged_micros = 0, run_token_closed_at = now(), run_token_expires_at = now() - interval '1 second' WHERE id = $1`, [runId]);
  const task = async (who: Person, title: string, projectId = place.id) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title } }), 201) as { id: string; number: number; version: number };
  const doc = async (who: Person, title: string, body = 'First text') =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title, body } }), 201) as { id: string; version: number };
  const docBody = async (id: string) => (await pool.query(`SELECT v.body, m.current_version FROM project_materials m JOIN project_material_versions v
    ON v.material_id = m.id AND v.version = m.current_version WHERE m.id = $1`, [id])).rows[0] as { body: string; current_version: number };
  const map = async (who: Person) => expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title: 'Sensor map', scope: 'project', projectId: place.id } }), 201) as { id: string };
  const thought = async (who: Person, mapId: string, textValue: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/sketches/${mapId}/thoughts`, { body: { text: textValue, x: 0, y: 0 } }), 201) as { thought?: { id: string; version: number }; id?: string; version?: number };
  const thoughtId = (created: Awaited<ReturnType<typeof thought>>) => (created.thought?.id ?? created.id)!;
  const thoughtVersion = (created: Awaited<ReturnType<typeof thought>>) => (created.thought?.version ?? created.version)!;
  /** Another person's open live session on a page (F-021 presence), as PR #389's signal records it. */
  async function typing(who: Person, docId: string) {
    const session = (await pool.query(`SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [who.id])).rows[0] as { id: string };
    const connection = randomUUID();
    await pool.query(`INSERT INTO doc_live_presence (connection_id, doc_id, generation, actor_id, session_id, cursor, expires_at)
      VALUES ($1, $2, $3, $4, $5, '{"anchor":"a","head":"a"}'::jsonb, now() + interval '5 minutes')`, [connection, docId, randomUUID(), who.id, session.id]);
    return () => pool.query(`DELETE FROM doc_live_presence WHERE connection_id = $1`, [connection]);
  }

  before(async () => {
    owner = await person('ac-ada');
    peer = await person('ac-jonas');
    outsider = await person('ac-other');
    ws = await createWorkspace(owner, 'Changes');
    await addMember(owner, ws.id, peer, 'member');
    await addMember(owner, ws.id, outsider, 'member');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    await grant(owner, place.id, peer, 'contributor');
    await grant(owner, place.id, outsider, 'contributor');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Please tidy the sensor tasks', clientMessageId: randomUUID() } }), 201) as Conversation;
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
    // Jonas's workspace: Ada is a member and contributes to "Shared rig"; Jonas manages it.
    jonasWs = await createWorkspace(peer, 'Jonas lab');
    await addMember(peer, jonasWs.id, owner, 'member');
    shared = await createProject(peer, jonasWs.id, 'Shared rig', 'restricted');
    await grant(peer, shared.id, owner, 'contributor');
    const jonasAgent = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${jonasWs.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    await runs.selectAgent(human(owner), { agentId: jonasAgent });
    expectStatus(await peer.browser.request('POST', `/api/v1/projects/${shared.id}/grants`, { body: { principal: { kind: 'agent', id: jonasAgent }, role: 'contributor' } }), 201);
    sharedThread = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${shared.id}/conversations`,
      { body: { body: 'Rig notes', clientMessageId: randomUUID() } }), 201) as Conversation;
    const jonasSettings = await settings(jonasWs.id);
    if (!jonasSettings.policy.selectedProjectIds.includes(shared.id))
      await save({ projectMode: 'chosen', selectedProjectIds: [shared.id] }, jonasWs.id);
  });
  beforeEach(async () => {
    compute.dispatched = []; compute.counted = [];
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    const current = await settings();
    if (current.approvalMode !== 'act' || current.areas.maps !== 'edit' || current.areas.wiki !== 'edit' || current.areas.tasks !== 'edit' || current.changesPerRun !== 20)
      await save({ approvalMode: 'act', changesPerRun: 20, areas: { maps: 'edit', wiki: 'edit', tasks: 'edit' } });
  });

  test('AST-4.3: with Only read for maps the map reads are listed and every map change tool is absent; edit lists them', async () => {
    const mapTools = ['flux_create_map', 'flux_rename_map', 'flux_add_thought', 'flux_update_thought', 'flux_remove_thought', 'flux_move_thoughts', 'flux_link_thoughts', 'flux_unlink_thoughts'];
    const edit = await liveRun();
    for (const name of mapTools) assert.ok(edit.tools.includes(name), `${name} with maps on`);
    await complete(edit.runId);
    await save({ areas: { maps: 'read' } });
    const read = await liveRun();
    assert.ok(read.tools.includes('flux_list_maps') && read.tools.includes('flux_get_map'), 'map reads stay');
    for (const name of mapTools) assert.ok(!read.tools.includes(name), `${name} is absent`);
    const listed = ((await mcp(read.token, 99, 'tools/list')).message?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    for (const name of mapTools) assert.ok(!listed.includes(name), `${name} is not listed`);
    // Only read: a forced map change is refused; the change log records nothing.
    assert.equal(refusalCode((await read.call('flux_create_map', { title: 'Sneaky' })).message), 'MCP_ENTRY_UNAVAILABLE');
    assert.deepEqual(await changesOf(read.runId), []);
    // Run-private view: no runtime, grant or class in a change tool's schema.
    const create = ((await mcp(read.token, 98, 'tools/list')).message?.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] }).tools
      .find((tool) => tool.name === 'flux_create_task')!;
    assert.ok(!('runtimeSessionId' in create.inputSchema.properties) && !('grantId' in create.inputSchema.properties) && !('peerRequestClass' in create.inputSchema.properties));
    assert.ok(!(create.inputSchema.required ?? []).includes('projectId'), 'the project defaults to the run\'s place');
    await complete(read.runId);
  });

  test('AST-5.2 (route): applied, waiting, suggestion and refused per row of the combination table, each in the change log', async () => {
    const theirsTask = await task(peer, 'Jonas calibrates the probes');
    const mine = await task(owner, 'Order spare probes');
    const run = await liveRun();
    // On, new: applies at once and returns the applied object; the receipt records the run's authority.
    const added = await run.call('flux_create_task', { task: { title: 'Check the lamp wiring' } });
    const value = JSON.parse(text(added.message)) as { workId: string; number: number };
    assert.ok(value.workId && value.number, 'the applied object');
    // On, yours: applies.
    assert.ok(JSON.parse(text((await run.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Order four spare probes' } })).message)).workId);
    // On, other people's things: waits, in plain words.
    const waiting = await run.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { status: 'done' } });
    assert.match(text(waiting.message), /^Waiting for ac-ada's OK: close task #\d+ Jonas calibrates the probes\.$/);
    assert.equal(result(waiting.message)?.isError, undefined, 'a plain tool result, not an error');
    // Off: no tool; a forced call is refused before anything runs.
    await save({ areas: { decisions: 'off' } });
    assert.equal(refusalCode((await run.call('flux_propose_decision', { decision: { title: 'Use PIR' } })).message), 'MCP_ENTRY_UNAVAILABLE');
    await save({ areas: { decisions: 'edit' } });
    const rows = await changesOf(run.runId);
    assert.deepEqual(rows.map((row) => [row.operation, row.state, row.wait_reason, row.authority]), [
      ['work.create', 'applied', null, 'owner_request'], ['work.update', 'applied', null, 'owner_request'], ['work.update', 'waiting', 'others', null]]);
    assert.equal(rows[0]!.receipt!.authority, 'owner_request');
    assert.equal(rows[0]!.receipt!.runId, run.runId);
    assert.equal(rows[0]!.receipt!.agentId, agentId);
    const stored = (await pool.query(`SELECT created_by_kind, created_by_id FROM project_work_items WHERE id = $1`, [value.workId])).rows[0];
    assert.deepEqual(stored, { created_by_kind: 'agent', created_by_id: agentId }, 'the assistant\'s agent is the author');
    assert.equal((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [theirsTask.id])).rows[0].status !== 'done', true, 'Jonas\'s task is untouched');
    // A retry of the same command returns the stored outcome: no second effect.
    const commandId = randomUUID();
    const first = JSON.parse(text((await run.call('flux_create_task', { clientCommandId: commandId, task: { title: 'Once' } })).message)) as { workId: string };
    const again = JSON.parse(text((await run.call('flux_create_task', { clientCommandId: commandId, task: { title: 'Once' } })).message)) as { workId: string };
    assert.equal(again.workId, first.workId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Once' AND project_id = $1`, [place.id])).rows[0].n, 1);
    await complete(run.runId);
  });

  test('AST-5.2 ("Ask me first") and the server engine: the same effect tool waits; Apply after the run and token ended commits exactly once with no model call', async () => {
    await save({ approvalMode: 'ask' });
    // The `server` engine: a fake provider calls the same tool through the worker's loop and the real /mcp route.
    const replies: PersonalComputeResult[] = [
      { kind: 'completed' as const, text: 'adding', stopReason: 'tool_use', usage: { inputTokens: 300, outputTokens: 20 },
        toolCalls: [{ id: 'c1', name: 'flux_create_task', input: { clientCommandId: randomUUID(), task: { title: 'Label the sensor cables' } } }] },
      { kind: 'completed' as const, text: 'Asked Ada first.', stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 20 } },
    ];
    compute.respond = async () => replies.shift()!;
    const started = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Add a task to label the cables' });
    assert.equal(await processor.process(started.run.id), 'completed');
    const toolTurn = JSON.stringify(compute.dispatched[1]?.turns ?? []);
    assert.ok(toolTurn.includes('Waiting for ac-ada') && toolTurn.includes('OK'), 'the provider got the plain result');
    const [row] = await changesOf(started.run.id);
    assert.deepEqual([row!.state, row!.wait_reason], ['waiting', 'ask']);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Label the sensor cables'`)).rows[0].n, 0, 'nothing applied yet');
    assert.ok((await pool.query(`SELECT run_token_closed_at FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0].run_token_closed_at, 'the run and its token ended');
    // Ten minutes later it is an Inbox question with the object's own verb (fake clock).
    const later = () => new Date(Date.now() + 11 * 60_000);
    const inbox = await needsYouUseCases(db, { waiting: (userId) => assistantChangeUseCases(db, undefined, later).inbox(userId) }).list(human(owner));
    const item = inbox.items.find((entry) => entry.key === `assistant:${started.run.id}`);
    assert.equal(item?.title, 'Your assistant wants to add 1 task');
    assert.equal(item?.assistantChanges?.verb, 'Add');
    // Apply within seven days: exactly one task, under owner_approval, with no provider call.
    const dispatched = compute.dispatched.length;
    const applied = expectStatus(await owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: { expectedVersion: row!.version } }), 200) as { change: AssistantChange };
    assert.equal(applied.change.state, 'applied_after_wait');
    assert.equal(applied.change.line, 'Approved by ac-ada');
    assert.equal(compute.dispatched.length, dispatched, 'no model call at Apply');
    const [after] = await changesOf(started.run.id);
    assert.deepEqual([after!.state, after!.authority, after!.decided_by], ['applied_after_wait', 'owner_approval', owner.id]);
    assert.equal(after!.receipt!.approvedBy, owner.id);
    assert.equal(after!.receipt!.preparedBy, agentId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Label the sensor cables'`)).rows[0].n, 1);
    // Replay of Apply creates nothing more.
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 409);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Label the sensor cables'`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [started.run.id])).rows[0].status, 'completed', 'the source run is not revived');
  });

  test('AST-5.3: each always-wait case waits in "Do it and tell me" with its reason; each never case has no tool and a forced call is refused', async () => {
    const mapId = (await map(owner)).id;
    const mineThought = await thought(owner, mapId, 'Lux threshold');
    const theirsTask = await task(peer, 'Jonas solders the board');
    const page = await doc(owner, 'Suppliers');
    const stopTyping = await typing(peer, page.id);
    const run = await liveRun();
    // 1 removal, 2 other people's things, 4 a page someone is typing in.
    assert.match(text((await run.call('flux_remove_thought', { mapId, thoughtId: thoughtId(mineThought), expectedVersion: thoughtVersion(mineThought) })).message), /^Waiting for ac-ada's OK: remove thought/);
    assert.match(text((await run.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { title: 'Solder it twice' } })).message), /^Waiting for/);
    assert.equal(text((await run.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Use Acme' } })).message),
      'I\'ll edit Suppliers when ac-jonas finishes typing.');
    await stopTyping();
    // 3 handing work to another person: no run tool can set another person responsible or hand off to their agent.
    for (const absent of ['flux_create_unit', 'flux_transfer_unit']) assert.ok(!run.tools.includes(absent), absent);
    // 5 past the run's limit: tested in AST-6.5. Never cases 6-8: no tool exists, a forced call is refused.
    for (const never of ['flux_create_unit', 'flux_bootstrap', 'flux_create_proposal']) {
      assert.ok(!run.tools.includes(never), `${never} is not listed`);
      assert.equal(refusalCode((await run.call(never, {})).message), 'MCP_ENTRY_UNAVAILABLE', `${never} is refused`);
    }
    assert.ok(!run.tools.some((name) => /grant|invite|accept|policy|setting/.test(name)), 'no access, acceptance or settings tool');
    const elsewhere = await run.call('flux_create_task', { projectId: shared.id, task: { title: 'Outside the place' } });
    assert.ok(result(elsewhere.message)?.isError || elsewhere.status === 403, 'another project is outside the run\'s place');
    const reasons = (expectStatus(await owner.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items
      .filter((change) => change.runId === run.runId).map((change) => [change.waitReason, change.line]);
    assert.deepEqual(reasons, [
      ['removal', 'Removing a thought always waits for you'],
      ['others', 'ac-jonas\'s task: changing it waits for you'],
      ['live_wiki', 'I\'ll edit Suppliers when ac-jonas finishes typing.'],
    ]);
    await complete(run.runId);
  });

  test('AST-5.4: Apply on a changed target applies nothing ("Changed since you asked"); lost write access, a switch off or Not now refuse it', async () => {
    const lens = await task(peer, 'Jonas checks the lens', shared.id);
    const clean = await task(peer, 'Jonas cleans the lens', shared.id);
    const order = await task(peer, 'Jonas orders a lens', shared.id);
    const rig = await liveRun(sharedThread);
    for (const [item, title] of [[lens, 'Check the lens twice'], [clean, 'Clean it gently'], [order, 'Order two']] as const)
      assert.match(text((await rig.call('flux_update_task', { workId: item.id, expectedVersion: item.version, changes: { title } })).message), /^Waiting for/);
    await complete(rig.runId);
    const [stale, lost, declined] = await changesOf(rig.runId);
    // The target changed since: nothing is applied and the item says so.
    expectStatus(await peer.browser.request('PATCH', `/api/v1/work/${lens.id}`, { body: { title: 'Jonas checks the lens today' }, headers: { 'if-match': `"${lens.version}"` } }), 200);
    const refused = await owner.browser.request('POST', assistantChangeActionPath(stale!.id, 'apply'), { body: {} });
    assert.equal(refused.status, 409);
    assert.equal((refused.json as { error: string }).error, 'Changed since you asked. Ask again');
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [lens.id])).rows[0].title, 'Jonas checks the lens today');
    // Not now closes it; a later Apply cannot revive it.
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(declined!.id, 'not-now'), { body: {} }), 200);
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(declined!.id, 'apply'), { body: {} }), 409);
    // Ada lost write access: refused, nothing changes; getting it back cannot revive the saved change.
    await pool.query(`UPDATE project_grants SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [shared.id, owner.id]);
    assert.equal((await owner.browser.request('POST', assistantChangeActionPath(lost!.id, 'apply'), { body: {} })).status, 403);
    await pool.query(`UPDATE project_grants SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [shared.id, owner.id]);
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(lost!.id, 'apply'), { body: {} }), 409);
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [clean.id])).rows[0].title, 'Jonas cleans the lens');
    assert.deepEqual((await changesOf(rig.runId)).map((row) => row.state), ['refused', 'refused', 'not_now']);
    // A switch turned to Only read invalidates intent at once; switching it on again cannot resurrect it.
    const theirsTask = await task(peer, 'Jonas aligns the rig');
    const next = await liveRun();
    await next.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { title: 'Align it today' } });
    await complete(next.runId);
    const [switched] = await changesOf(next.runId);
    await save({ areas: { tasks: 'read' } });
    assert.deepEqual((await changesOf(next.runId)).map((row) => [row.state, row.refusal]), [['refused', 'Your assistant\'s switches changed since. Ask again']]);
    await save({ areas: { tasks: 'edit' } });
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(switched!.id, 'apply'), { body: {} }), 409);
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [theirsTask.id])).rows[0].title, 'Jonas aligns the rig');
  });

  test('AST-5.5: a waiting change is invisible to other members and expires after seven days with its Recent line (fake clock)', async () => {
    const theirsTask = await task(peer, 'Jonas tests at night');
    const run = await liveRun();
    await run.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { status: 'done' } });
    await complete(run.runId);
    const [row] = await changesOf(run.runId);
    for (const other of [peer, outsider]) {
      assert.equal((await other.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} })).status, 404);
      assert.equal((await other.browser.request('POST', assistantChangeActionPath(row!.id, 'not-now'), { body: {} })).status, 404);
      assert.equal((await other.browser.request('GET', `/api/v1/assistant-runs/${run.runId}/changes`)).status, 404);
      const listed = expectStatus(await other.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] };
      assert.ok(!listed.items.some((change) => change.id === row!.id), 'not in another member\'s list');
      const inbox = expectStatus(await other.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
      assert.ok(!inbox.items.some((item) => item.key === `assistant:${run.runId}`));
    }
    // Seven days later (fake clock): expired, never applied, with "Expired: … · Ask again".
    const week = assistantChangeUseCases(db, undefined, () => new Date(Date.now() + 7 * DAY + 60_000));
    await assert.rejects(week.apply(human(owner), row!.id), (error: Error & { code?: string }) => error.code === 'ASSISTANT_CHANGE_EXPIRED');
    const [expired] = (await week.forRun(human(owner), run.runId)).items;
    assert.equal(expired!.state, 'expired');
    assert.equal(expired!.line, 'Expired: close task · Ask again');
    assert.notEqual((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [theirsTask.id])).rows[0].status, 'done');
  });

  test('AST-5.6 (API): an undecided waiting change is one Inbox question when the owner leaves the conversation, with the object\'s verb', async () => {
    const mapId = (await map(owner)).id;
    const a = await thought(owner, mapId, 'Old idea');
    const b = await thought(owner, mapId, 'Older idea');
    const run = await liveRun();
    await run.call('flux_remove_thought', { mapId, thoughtId: thoughtId(a), expectedVersion: thoughtVersion(a) });
    await run.call('flux_remove_thought', { mapId, thoughtId: thoughtId(b), expectedVersion: thoughtVersion(b) });
    const before = expectStatus(await owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    assert.ok(!before.items.some((item) => item.key === `assistant:${run.runId}`), 'not in Inbox while the owner is still there');
    expectStatus(await owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'inbox'), { body: {} }), 200);
    const after = expectStatus(await owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    const item = after.items.find((entry) => entry.key === `assistant:${run.runId}`)!;
    assert.equal(item.title, 'Your assistant wants to remove 2 thoughts');
    assert.equal(item.kind, 'question');
    assert.equal(item.assistantChanges?.verb, 'Remove');
    // Apply all from Inbox while the run is still live: both removals commit under owner_approval.
    const all = expectStatus(await owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'apply'), { body: {} }), 200) as { changes: { change: AssistantChange; message: string | null }[] };
    assert.deepEqual(all.changes.map((entry) => [entry.change.state, entry.message]), [['applied_after_wait', null], ['applied_after_wait', null]]);
    const gone = expectStatus(await owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    assert.ok(!gone.items.some((entry) => entry.key === `assistant:${run.runId}`), 'decided: no longer in Inbox');
    await complete(run.runId);
  });

  test('AST-5.7: an edit of a page someone is typing in is deferred, applies when the session ends if the version matches, and otherwise waits', async () => {
    const sweeper = assistantChangeUseCases(db);
    const page = await doc(owner, 'Probe notes');
    let stop = await typing(peer, page.id);
    const run = await liveRun();
    assert.equal(text((await run.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Calibrated at two depths' } })).message),
      'I\'ll edit Probe notes when ac-jonas finishes typing.');
    // The source run and its token end before the session does: the exact edit continues under its reserved allowance.
    await complete(run.runId);
    await sweeper.sweep();
    assert.equal((await docBody(page.id)).body, 'First text', 'nothing while Jonas types');
    await stop();
    await sweeper.sweep();
    assert.equal((await docBody(page.id)).body, 'Calibrated at two depths', 'applied once the session ended, version matching');
    const [row] = await changesOf(run.runId);
    assert.deepEqual([row!.state, row!.authority], ['applied_after_wait', 'owner_deferred_change']);
    // The page changed while they typed: an ordinary waiting change.
    const other = await doc(owner, 'Supplier list');
    stop = await typing(peer, other.id);
    const second = await liveRun();
    await second.call('flux_update_doc', { docId: other.id, expectedVersion: other.version, changes: { body: 'Acme only' } });
    expectStatus(await peer.browser.request('PATCH', `/api/v1/docs/${other.id}`, { body: { body: 'Jonas typed this' }, headers: { 'if-match': `"${other.version}"` } }), 200);
    await stop();
    await sweeper.sweep();
    const [changed] = await changesOf(second.runId);
    assert.deepEqual([changed!.state, changed!.wait_reason], ['waiting', 'conflict']);
    assert.equal((await docBody(other.id)).body, 'Jonas typed this');
    // "Ask me first" by the time the session ends: it waits for the owner's Apply.
    const third = await doc(owner, 'Lux table');
    stop = await typing(peer, third.id);
    await second.call('flux_update_doc', { docId: third.id, expectedVersion: third.version, changes: { body: 'Below 5 lux fails' } });
    await save({ approvalMode: 'ask' });
    await stop();
    await sweeper.sweep();
    const thirdRow = (await changesOf(second.runId)).at(-1)!;
    assert.deepEqual([thirdRow.state, thirdRow.wait_reason], ['waiting', 'ask']);
    assert.equal((await docBody(third.id)).body, 'First text');
    // Stop invalidates a deferral: the sweep refuses it.
    await complete(second.runId);
    await save({ approvalMode: 'act' });
    const fourth = await doc(owner, 'Wiring');
    stop = await typing(peer, fourth.id);
    const stopped = await liveRun();
    await stopped.call('flux_update_doc', { docId: fourth.id, expectedVersion: fourth.version, changes: { body: 'Red is live' } });
    await pool.query(`UPDATE personal_runs SET stop_requested_at = now(), status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [stopped.runId]);
    await stop();
    await sweeper.sweep();
    assert.equal((await changesOf(stopped.runId))[0]!.state, 'refused');
    assert.equal((await docBody(fourth.id)).body, 'First text');
  });

  test('AST-5.8: a change outside the owner\'s rights reaches the other person only after "Send to Jonas"', async () => {
    const run = await liveRun(sharedThread);
    // Jonas makes Ada a viewer during the run: her change is now outside her rights (her assistant is capped too).
    await pool.query(`UPDATE project_grants SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [shared.id, owner.id]);
    try {
      const prepared = await run.call('flux_create_task', { task: { title: 'Recalibrate the bench' } });
      assert.equal(text(prepared.message), 'Prepared as a suggestion: add task. ac-ada decides whether to send it.');
      const [row] = await changesOf(run.runId);
      assert.deepEqual([row!.state, row!.wait_reason], ['waiting', 'outside_rights']);
      const notes = async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%assistant suggests%'`, [peer.id])).rows[0].n as number;
      assert.equal(await notes(), 0, 'no Needs-you item for Jonas before the tap');
      const jonasBefore = expectStatus(await peer.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
      assert.ok(!jonasBefore.items.some((item) => item.title.includes('suggests')));
      const listed = (expectStatus(await owner.browser.request('GET', conversationAssistantChangesPath(sharedThread.id)), 200) as { items: AssistantChange[] }).items;
      assert.equal(listed.find((change) => change.id === row!.id)!.line, 'ac-jonas can decide this. Suggest this change to them? · Send to ac-jonas');
      // Apply is not how a suggestion moves: only Send.
      expectStatus(await owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 409);
      const sent = expectStatus(await owner.browser.request('POST', assistantChangeActionPath(row!.id, 'send'), { body: { expectedVersion: row!.version } }), 200) as { change: AssistantChange };
      assert.equal(sent.change.line, 'Sent to ac-jonas');
      assert.equal(await notes(), 1);
      const jonas = expectStatus(await peer.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
      const item = jonas.items.find((entry) => entry.title.includes('suggests'))!;
      assert.equal(item.kind, 'question');
      assert.equal(item.title, 'ac-ada\'s assistant suggests: add task Recalibrate the bench');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Recalibrate the bench'`)).rows[0].n, 0, 'nothing applied on Ada\'s side');
    } finally {
      await pool.query(`UPDATE project_grants SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [shared.id, owner.id]);
      await complete(run.runId);
    }
  });

  test('AST-6.5: the 21st change in one run waits instead of applying', async () => {
    const run = await liveRun();
    for (let i = 1; i <= 20; i += 1) assert.ok(JSON.parse(text((await run.call('flux_create_task', { task: { title: `Batch task ${i}` } })).message)).workId, `change ${i} applies`);
    const twentyFirst = await run.call('flux_create_task', { task: { title: 'Batch task 21' } });
    assert.match(text(twentyFirst.message), /^Waiting for ac-ada's OK: add task Batch task 21\.$/);
    const rows = await changesOf(run.runId);
    assert.equal(rows.filter((row) => row.state === 'applied').length, 20);
    assert.deepEqual([rows.at(-1)!.state, rows.at(-1)!.wait_reason], ['waiting', 'limit']);
    const listed = expectStatus(await owner.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] };
    assert.equal(listed.items.find((change) => change.id === rows.at(-1)!.id)!.line, 'Past this request\'s limit of 20 changes');
    await complete(run.runId);
  });

  test('AST-6.7: a person\'s edit between the run\'s read and its write makes that write "Skipped #4: Jonas changed it while I worked"; nothing is retried', async () => {
    const mine = await task(owner, 'Measure the beam angle');
    const run = await liveRun();
    // The run read version 1; Jonas edits the task before the run writes.
    expectStatus(await peer.browser.request('PATCH', `/api/v1/work/${mine.id}`, { body: { outcome: 'Done by hand' }, headers: { 'if-match': `"${mine.version}"` } }), 200);
    const skipped = await run.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Measure it twice' } });
    assert.equal(result(skipped.message)?.isError, true);
    const refusal = JSON.parse(text(skipped.message)) as { code: string; error: string };
    assert.equal(refusal.code, 'ASSISTANT_CHANGE_SKIPPED');
    assert.equal(refusal.error, `Skipped #${mine.number}: ac-jonas changed it while I worked`);
    const rows = await changesOf(run.runId);
    assert.deepEqual(rows.map((row) => [row.state, row.refusal]), [['refused', refusal.error]]);
    assert.equal((await pool.query(`SELECT title, version FROM project_work_items WHERE id = $1`, [mine.id])).rows[0].title, 'Measure the beam angle', 'not retried');
    await complete(run.runId);
  });

  test('AST-9.2: a run writing an `sk-ant-…` string into a Wiki page commits "[removed: looked like a secret]" instead', async () => {
    const page = await doc(owner, 'Keys');
    const run = await liveRun();
    const secret = `sk-ant-api03-${randomBytes(16).toString('hex')}`;
    const saved = JSON.parse(text((await run.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: `The key is ${secret}` } })).message)) as { docId: string };
    assert.equal(saved.docId, page.id);
    const stored = await docBody(page.id);
    assert.equal(stored.body, 'The key is [removed: looked like a secret]');
    const log = (await pool.query(`SELECT row_to_json(c)::text AS row FROM assistant_changes c WHERE run_id = $1`, [run.runId])).rows.map((r) => r.row as string).join('');
    assert.ok(!log.includes(secret), 'nor does the change log hold it');
    await complete(run.runId);
  });

  test('#580 review: a 90 KB applied page edit commits cleanly; a 70 KB waiting change is refused with 413 and nothing is written', async () => {
    const mine = await doc(owner, 'Long log');
    const theirs = await doc(peer, 'Their long log');
    const run = await liveRun();
    const big = 'measurement line. '.repeat(5_000);
    const saved = await run.call('flux_update_doc', { docId: mine.id, expectedVersion: mine.version, changes: { body: big } });
    assert.equal(result(saved.message)?.isError, undefined, text(saved.message));
    assert.equal((await docBody(mine.id)).body, big);
    const [applied] = await changesOf(run.runId);
    assert.equal(applied!.state, 'applied');
    const kept = (await pool.query(`SELECT octet_length(prepared_command::text) AS n FROM assistant_changes WHERE id = $1`, [applied!.id])).rows[0].n as number;
    assert.ok(kept < 1_000, 'an applied change keeps only a summary of its call');
    const tooLarge = await run.call('flux_update_doc', { docId: theirs.id, expectedVersion: theirs.version, changes: { body: 'x'.repeat(70_000) } });
    assert.equal(refusalCode(tooLarge.message), 'ASSISTANT_CHANGE_TOO_LARGE');
    assert.equal((await changesOf(run.runId)).length, 1, 'nothing written for the refused waiting change');
    assert.equal((await docBody(theirs.id)).body, 'First text');
    await complete(run.runId);
  });

  // --- A4 (#404): the run's message, Undo, Stop, recovery and the queue ---
  const listRun = async (runId: string) => (expectStatus(await owner.browser.request('GET', assistantRunChangesPath(runId)), 200) as { items: AssistantChange[] }).items;
  const undoRun = async (runId: string) => expectStatus(await owner.browser.request('POST', assistantRunChangesActionPath(runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
  const patchWork = async (who: Person, id: string, version: number, body: Record<string, unknown>) =>
    expectStatus(await who.browser.request('PATCH', `/api/v1/work/${id}`, { body, headers: { 'if-match': `"${version}"` } }), 200);

  test('AST-6.1: "add two tasks and update the probes page" makes two tasks and one page version by the assistant, three change-log rows and one message "Done: added 2 tasks, edited 1 page" with Undo', async () => {
    const page = await doc(owner, 'Probes', 'Probe notes\n\nSecond paragraph');
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Calibrate the probes' } });
    await run.call('flux_create_task', { task: { title: 'Order spare probes' } });
    await run.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Probe notes\n\nSecond paragraph, now complete' } });
    const authors = (await pool.query(`SELECT author_agent_id FROM project_material_versions WHERE material_id = $1 AND version = $2`, [page.id, page.version + 1])).rows;
    assert.deepEqual(authors, [{ author_agent_id: agentId }], 'one page version authored by the assistant agent');
    assert.equal((await changesOf(run.runId)).length, 3);
    // While it works there is no message yet; once it ended the one message has its header, rows and before/after.
    assert.ok((await listRun(run.runId)).every((change) => change.runState === 'working'));
    await complete(run.runId);
    const items = await listRun(run.runId);
    assert.equal(assistantMessageHeader(items), 'Done: added 2 tasks, edited 1 page');
    assert.ok(items.every((change) => change.undoable && change.runState === 'done'));
    assert.equal(items.find((change) => change.operation === 'doc.update')!.after, '1 paragraph changed');
    assert.equal(items.find((change) => change.operation === 'work.create')!.after, 'Calibrate the probes');
  });

  test('AST-10.7 (API): Recent lists the owner\'s own changes across conversations, newest first, with their Undo; nobody else sees them', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Recent one' } });
    await run.call('flux_create_task', { task: { title: 'Recent two' } });
    await complete(run.runId);
    const listed = expectStatus(await owner.browser.request('GET', `${ASSISTANT_CHANGES_PATH}?limit=2`), 200) as { items: AssistantChange[] };
    assert.equal(listed.items.length, 2, 'the limit holds');
    assert.deepEqual(listed.items.map((change) => change.objectTitle), ['Recent two', 'Recent one']);
    assert.ok(listed.items.every((change) => change.undoable && change.runId === run.runId && change.conversationId === thread.id));
    for (const other of [peer, outsider]) {
      const theirs = expectStatus(await other.browser.request('GET', ASSISTANT_CHANGES_PATH), 200) as { items: AssistantChange[] };
      assert.ok(!theirs.items.some((change) => change.runId === run.runId), 'never another person\'s changes');
    }
    // Undo from Recent is the same service as the message\'s Undo.
    const undone = expectStatus(await owner.browser.request('POST', assistantChangeActionPath(listed.items[0]!.id, 'undo'), { body: {} }), 200) as { change: AssistantChange };
    assert.equal(undone.change.state, 'undone');
  });

  test('AST-6.2: Undo restores the page as a new version and removes both tasks; field-level: a state change does not block a rename, an edit of the same title does', async () => {
    const page = await doc(owner, 'Wiring', 'Wire notes');
    const renamed = await task(owner, 'Probes');
    const retitled = await task(owner, 'Lamp driver');
    const run = await liveRun();
    const made = JSON.parse(text((await run.call('flux_create_task', { task: { title: 'Fresh task' } })).message)) as { workId: string };
    await run.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Wire notes, extended' } });
    await run.call('flux_update_task', { workId: renamed.id, expectedVersion: renamed.version, changes: { title: 'Calibrate the probes at two depths' } });
    await run.call('flux_update_task', { workId: retitled.id, expectedVersion: retitled.version, changes: { title: 'Lamp driver, rev B' } });
    await complete(run.runId);
    // A person moves the renamed task to In progress; another edits the other title.
    const current = (await pool.query(`SELECT version FROM project_work_items WHERE id = $1`, [renamed.id])).rows[0].version as number;
    await patchWork(peer, renamed.id, current, { status: 'in_progress' });
    const other = (await pool.query(`SELECT version FROM project_work_items WHERE id = $1`, [retitled.id])).rows[0].version as number;
    await patchWork(peer, retitled.id, other, { title: 'Lamp driver v3' });
    // Another member cannot undo it.
    expectStatus(await peer.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} }), 404);
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 3);
    assert.deepEqual(undone.changedSince, [`#${retitled.number}`]);
    assert.equal(undone.message, `Undid 3 changes. 1 changed since: #${retitled.number}`);
    assert.equal((await docBody(page.id)).body, 'Wire notes', 'the earlier text is back');
    assert.equal((await docBody(page.id)).current_version, page.version + 2, 'as a new version, never a rewrite');
    const rows = (await pool.query(`SELECT id, title, status FROM project_work_items WHERE id = ANY($1)`, [[renamed.id, retitled.id, made.workId]])).rows as { id: string; title: string; status: string }[];
    assert.deepEqual(rows.find((row) => row.id === renamed.id), { id: renamed.id, title: 'Probes', status: 'in_progress' }, 'the rename is undone, the state stays');
    assert.equal(rows.find((row) => row.id === retitled.id)!.title, 'Lamp driver v3', 'the edited title is untouched');
    const log = await changesOf(run.runId);
    assert.deepEqual(log.map((row) => row.state), ['undone', 'undone', 'undone', 'applied'], 'a refused item stays applied');
    assert.equal(log[0]!.decided_by, owner.id, 'the Undo is recorded as the owner\'s');
    const listed = await listRun(run.runId);
    assert.equal(listed.find((change) => change.state === 'undone')!.line, 'Undone by ac-ada');
    // Undoing the same message again does only what is left, and says "Changed since" for the one that did.
    const again = await undoRun(run.runId);
    assert.equal(again.undone, 0);
    const single = expectStatus(await owner.browser.request('POST', assistantChangeActionPath(log[3]!.id, 'undo'), { body: {} }), 200) as { message: string | null };
    assert.equal(single.message, 'Changed since. Open it');
    expectStatus(await peer.browser.request('POST', assistantChangeActionPath(log[3]!.id, 'undo'), { body: {} }), 404);
  });

  test('AST-6.2: a created thought and link are removed; a created page moves to drafts; a map thought text is restored only when untouched', async () => {
    const sketch = await map(owner);
    const mine = await thought(owner, sketch.id, 'Sensor rig');
    const run = await liveRun();
    const added = JSON.parse(text((await run.call('flux_add_thought', { mapId: sketch.id, thought: { text: 'Mount the lamp', x: 40, y: 40, linkFrom: { thoughtId: thoughtId(mine) } } })).message)) as { thoughtId: string; linkId: string };
    await run.call('flux_update_thought', { mapId: sketch.id, thoughtId: thoughtId(mine), expectedVersion: thoughtVersion(mine), changes: { text: 'Sensor rig v2' } });
    const page = JSON.parse(text((await run.call('flux_create_doc', { doc: { title: 'Mounting', body: 'How to mount', state: 'published' } })).message)) as { docId: string };
    await complete(run.runId);
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 3, undone.message);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sketch_thoughts WHERE id = $1`, [added.thoughtId])).rows[0].n, 0, 'the created thought is removed');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sketch_links WHERE id = $1`, [added.linkId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT text FROM sketch_thoughts WHERE id = $1`, [thoughtId(mine)])).rows[0].text, 'Sensor rig');
    const moved = (await pool.query(`SELECT v.state FROM project_materials m JOIN project_material_versions v ON v.material_id = m.id AND v.version = m.current_version WHERE m.id = $1`, [page.docId])).rows[0];
    assert.equal(moved.state, 'draft', 'moved to the owner\'s drafts');
    assert.ok(undone.changes.some((entry) => entry.message === 'Moved to your drafts'));
  });

  test('AST-6.3: a worker killed after two committed changes leaves a message with exactly those two changes once recovery ends the run', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Committed one' } });
    await run.call('flux_create_task', { task: { title: 'Committed two' } });
    await pool.query(`UPDATE personal_runs SET updated_at = now() - interval '1 hour' WHERE id = $1`, [run.runId]);
    assert.ok(await recoverPersonalRuns(personalRunWorkerUnitOfWork(db)) >= 1);
    const items = await listRun(run.runId);
    assert.equal(items.length, 2);
    assert.ok(items.every((change) => change.runState === 'failed' && change.undoable), 'a dead run still posts what it changed, with Undo');
    assert.equal(assistantMessageHeader(items), 'Done: added 2 tasks');
  });

  test('AST-6.4: Stop makes the next tool call fail with 403, keeps the committed changes and the message says "Stopped after 2 changes"', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Before the stop one' } });
    await run.call('flux_create_task', { task: { title: 'Before the stop two' } });
    expectStatus(await owner.browser.request('POST', `/api/v1/assistant-runs/${run.runId}/stop`), 200);
    const refused = await run.call('flux_create_task', { task: { title: 'After the stop' } });
    assert.equal(refused.status, 403);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'After the stop' AND project_id = $1`, [place.id])).rows[0].n, 0);
    const items = await listRun(run.runId);
    assert.equal(items.length, 2);
    assert.equal(assistantMessageHeader(items), 'Stopped after 2 changes');
    assert.ok(items.every((change) => change.undoable));
  });

  test('AST-6.6: receipts record the owner, the agent, the engine and the run id; no log row or receipt holds a vendor credential', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Receipt check sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    await complete(run.runId);
    const [row] = await changesOf(run.runId);
    assert.deepEqual([row!.receipt!.ownerUserId, row!.receipt!.agentId, row!.receipt!.runId, typeof row!.receipt!.engine], [owner.id, agentId, run.runId, 'string']);
    const everything = JSON.stringify((await pool.query(`SELECT * FROM assistant_changes WHERE run_id = $1`, [run.runId])).rows);
    assert.ok(!everything.includes('sk-ant-'), 'no seeded secret in the change log');
    assert.ok(!everything.includes(run.token), 'no run token in the change log');
  });

  test('AST-6.8: a request behind the working one waits in the lane, starts when it ends, and a third is refused; others see nothing of it', async () => {
    const first = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy the project' });
    const behind = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Turn this into tasks' });
    assert.equal(behind.run.status, 'queued');
    await assert.rejects(runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'A third' }), { code: 'PERSONAL_RUN_IN_FLIGHT' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [first.run.id]);
    assert.equal(await processor.process(behind.run.id), 'skipped', 'it waits while the first works');
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [behind.run.id])).rows[0].status, 'queued');
    const startable = () => personalRunWorkerUnitOfWork(db).run((ports) => ports.runs.startableQueued(50));
    assert.ok(!(await startable()).includes(behind.run.id), 'not startable while the lane is busy');
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now() WHERE id = $1`, [first.run.id]);
    assert.ok((await startable()).includes(behind.run.id), 'startable once the first ended');
    // Cancel is Stop of the queued request, at zero cost.
    const cancelled = expectStatus(await owner.browser.request('POST', `/api/v1/assistant-runs/${behind.run.id}/stop`), 200) as { status: string };
    assert.equal(cancelled.status, 'stopped');
    // Others in the place cannot see the owner's run.
    expectStatus(await peer.browser.request('GET', `/api/v1/assistant-runs/${behind.run.id}`), 404);
  });

  test('the change log goes with its project when the project is erased', async () => {
    const scratch = await createProject(owner, ws.id, 'Scratch', 'workspace');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${scratch.id}/conversations`,
      { body: { body: 'Scratch thread', clientMessageId: randomUUID() } }), 201) as Conversation;
    const current = await settings();
    if (!current.policy.selectedProjectIds.includes(scratch.id))
      await save({ projectMode: 'chosen', selectedProjectIds: [...new Set([...current.policy.selectedProjectIds, scratch.id])] });
    const run = await liveRun(conversation);
    assert.ok(JSON.parse(text((await run.call('flux_create_task', { task: { title: 'Scratch task' } })).message)).workId);
    assert.equal((await changesOf(run.runId)).length, 1);
    await complete(run.runId);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [scratch.id]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM assistant_changes WHERE project_id = $1`, [scratch.id])).rows[0].n, 0);
  });

  test('every listed change tool is one of the run-private set', async () => {
    const run = await liveRun();
    const effects = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
    const listedEffects = run.tools.filter((name) => !name.startsWith('flux_list') && !name.startsWith('flux_get') && !['flux_read_material', 'flux_search_project', 'flux_project_orientation', 'flux_changes_since'].includes(name));
    for (const name of listedEffects) assert.ok(effects.has(name), name);
    assert.equal(listedEffects.length, ASSISTANT_RUN_EFFECT_TOOLS.length, 'every switch on lists every change tool');
    await complete(run.runId);
  });
});
