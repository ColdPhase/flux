import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import * as Y from 'yjs';
import {
  agentConnectionPath, ASSISTANT_RUN_EFFECT_TOOLS, assistantChangeActionPath, assistantChangeLine, assistantRunChangesPath, assistantRunChangesActionPath, conversationAssistantChangesPath,
  NEEDS_YOU_PATH, personalRunTokenPath,
  type AgentMayDo, type AssistantChange, type AssistantRunUndone, type Conversation, type NeedsYouResponse, type Project, type Workspace,
} from '@flux/contracts';
import { createPersonalRunProcessor, recoverPersonalRuns, type PersonalComputeResult, type Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { assistantChangeUseCases } from '../../apps/server/src/assistant/changes.js';
import { needsYouUseCases } from '../../apps/server/src/needs-you/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { mcpToolHost } from '../../apps/worker/src/personal-runs/mcp-session.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { agentSettings } from './support/agent-settings.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { mcp, toolValue } from './support/mcp.js';
import { agentConnection, approveWaiting, waits } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';

// F-027 A3 (#403), F-036 AG-3 (#855): the change log, run authority and "What it may do". An assistant run's change tool goes
// through the real `/mcp` route with the run's own token (the `runtime` engine's path) and, for "Ask me first", through the
// worker's tool loop with a FAKE provider (the `server` engine's path). Every call is classified as applied, waiting or refused
// and recorded in `assistant_changes` in the same transaction. Waiting changes are approved by the owner only, with every check
// repeated. No model, CLI or vendor account is used. The F-036 rules themselves are in assistant-what-it-may-do.test.ts.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const tokens = runTokenIssuer(db, apiUrl);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20,
  tools: mcpToolHost(tokens, `${apiUrl}/mcp`), tokens });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
type Message = Record<string, unknown> | null;
const result = (message: Message) => message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
const text = (message: Message) => result(message)?.content?.[0]?.text ?? '';
const refusalCode = (message: Message) => result(message)?.isError ? (JSON.parse(text(message)) as { code?: string }).code : undefined;

interface ChangeRow { id: string; state: string; wait_reason: string | null; authority: string | null; operation: string; object_id: string | null;
  receipt: Record<string, unknown> | null; refusal: string | null; decided_by: string | null; version: number; run_id: string }
const changesOf = async (runId: string) => (await pool.query(`SELECT * FROM assistant_changes WHERE run_id = $1 ORDER BY created_at, id`, [runId])).rows as ChangeRow[];

describe('the assistant\'s change log, run authority and "Ask me first" (F-027 A3, #403)', () => {
  let owner: Person; let peer: Person; let outsider: Person; let stranger: Person; let ws: Workspace; let place: Project;
  let thread: Conversation; let agentId: string;
  /** Jonas's workspace, where Ada is a member and contributes to one project. */
  let jonasWs: Workspace; let shared: Project; let sharedThread: Conversation;

  const settings = (workspaceId = ws.id) => agentSettings(owner, workspaceId);
  /** "What it may do" (F-036 AG-3), set on the assistant's connection by its owner. */
  async function setMayDo(mayDo: AgentMayDo, workspaceId = ws.id) {
    expectStatus(await owner.browser.request('PATCH', agentConnectionPath((await settings(workspaceId)).connectionId), { body: { mayDo } }), 200);
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

  before(async () => {
    owner = await person('ac-ada');
    peer = await person('ac-jonas');
    outsider = await person('ac-other');
    stranger = await person('ac-stranger');
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
    await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
    // Jonas's workspace: Ada is a member and contributes to "Shared rig"; Jonas manages it.
    jonasWs = await createWorkspace(peer, 'Jonas lab');
    await addMember(peer, jonasWs.id, owner, 'member');
    shared = await createProject(peer, jonasWs.id, 'Shared rig', 'restricted');
    await grant(peer, shared.id, owner, 'contributor');
    const jonasAgent = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${jonasWs.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    await runs.enable(human(owner), { agentId: jonasAgent });
    // The assistant reaches Shared rig because Ada does (F-036 AG-3): no join request, grant or project list.
    sharedThread = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${shared.id}/conversations`,
      { body: { body: 'Rig notes', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  beforeEach(async () => {
    compute.dispatched = []; compute.counted = [];
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    if ((await settings()).mayDo !== 'act') await setMayDo('act');
  });

  test('AST-5.2 (route): applied and waiting per row of the table, each in the change log', async () => {
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
    await setMayDo('ask');
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
    // At once, the run is one Inbox item for its owner (F-036 AG-7), with Approve all.
    const inbox = await needsYouUseCases(db, { waiting: (userId) => assistantChangeUseCases(db).inbox(userId) }).list(human(owner));
    const item = inbox.items.find((entry) => entry.key === `assistant:${started.run.id}`);
    assert.equal(item?.title, '1 thing waits for you');
    assert.equal(item?.assistantChanges?.changes[0]?.waitReason, 'ask');
    // Approve: exactly one task, under owner_approval, with no provider call.
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

  test('AST-5.4: Approve on a changed target applies nothing ("Changed since you asked"); lost write access, Only read or Skip refuse it', async () => {
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
    assert.equal((refused.json as { error: string }).error, 'Changed since you asked');
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [lens.id])).rows[0].title, 'Jonas checks the lens today');
    // Skip closes it; a later Approve cannot revive it.
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(declined!.id, 'skip'), { body: {} }), 200);
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(declined!.id, 'apply'), { body: {} }), 409);
    // Ada was removed from the space: refused, nothing changes; being added back cannot revive the saved change.
    await pool.query(`DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2`, [shared.id, owner.id]);
    assert.equal((await owner.browser.request('POST', assistantChangeActionPath(lost!.id, 'apply'), { body: {} })).status, 403);
    await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) SELECT $1, workspace_id, id, $2, 'contributor', $2 FROM projects WHERE id = $3`, [randomUUID(), owner.id, shared.id]);
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(lost!.id, 'apply'), { body: {} }), 409);
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [clean.id])).rows[0].title, 'Jonas cleans the lens');
    assert.deepEqual((await changesOf(rig.runId)).map((row) => row.state), ['refused', 'refused', 'skipped']);
    // "What it may do" set to Only read since: an Approve is refused and closes it; nothing changes.
    const theirsTask = await task(peer, 'Jonas aligns the rig');
    const next = await liveRun();
    await next.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { title: 'Align it today' } });
    await complete(next.runId);
    const [switched] = await changesOf(next.runId);
    await setMayDo('read');
    assert.equal((await owner.browser.request('POST', assistantChangeActionPath(switched!.id, 'apply'), { body: {} })).status, 403);
    await setMayDo('act');
    expectStatus(await owner.browser.request('POST', assistantChangeActionPath(switched!.id, 'apply'), { body: {} }), 409);
    assert.equal((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [theirsTask.id])).rows[0].title, 'Jonas aligns the rig');
  });

  test('AST-5.5: a waiting change is invisible to other members, and nobody else can approve or skip it', async () => {
    const theirsTask = await task(peer, 'Jonas tests at night');
    const run = await liveRun();
    await run.call('flux_update_task', { workId: theirsTask.id, expectedVersion: theirsTask.version, changes: { status: 'done' } });
    await complete(run.runId);
    const [row] = await changesOf(run.runId);
    for (const other of [peer, outsider]) {
      assert.equal((await other.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} })).status, 404);
      assert.equal((await other.browser.request('POST', assistantChangeActionPath(row!.id, 'skip'), { body: {} })).status, 404);
      assert.equal((await other.browser.request('GET', `/api/v1/assistant-runs/${run.runId}/changes`)).status, 404);
      const listed = expectStatus(await other.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] };
      assert.ok(!listed.items.some((change) => change.id === row!.id), 'not in another member\'s list');
      const inbox = expectStatus(await other.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
      assert.ok(!inbox.items.some((item) => item.key === `assistant:${run.runId}`));
    }
    // Nothing waiting expires (F-036): it still waits for its owner.
    assert.equal((await changesOf(run.runId))[0]!.state, 'waiting');
    assert.notEqual((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [theirsTask.id])).rows[0].status, 'done');
  });

  test('#843: a run has no change limit of its own: the 21st change in one run applies like the first', async () => {
    const run = await liveRun();
    for (let i = 1; i <= 21; i += 1) assert.ok(JSON.parse(text((await run.call('flux_create_task', { task: { title: `Batch task ${i}` } })).message)).workId, `change ${i} applies`);
    const rows = await changesOf(run.runId);
    assert.equal(rows.filter((row) => row.state === 'applied').length, 21);
    assert.equal(rows.some((row) => row.state === 'waiting'), false);
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

  test('AST-6.1: "add two tasks and update the probes page" makes two tasks and one page version by the assistant, three change-log rows and one change line with Undo', async () => {
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
    assert.equal(assistantChangeLine(items), 'Added task Calibrate the probes · added task Order spare probes · updated the Wiki page Probes');
    assert.ok(items.every((change) => change.undoable && change.runState === 'done'));
    assert.equal(items.find((change) => change.operation === 'doc.update')!.after, '1 paragraph changed');
    assert.equal(items.find((change) => change.operation === 'work.create')!.after, 'Calibrate the probes');
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
    // Anyone who may edit may undo it (assistant-authority.test.ts); someone who cannot even read the project cannot.
    expectStatus(await stranger.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} }), 404);
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
    const byPeer = expectStatus(await peer.browser.request('POST', assistantChangeActionPath(log[3]!.id, 'undo'), { body: {} }), 200) as { message: string | null };
    assert.equal(byPeer.message, 'Changed since. Open it', 'someone who may edit gets the same truthful answer');
    expectStatus(await stranger.browser.request('POST', assistantChangeActionPath(log[3]!.id, 'undo'), { body: {} }), 404);
  });

  test('AST-6.2: a created thought, link and page are removed; a map thought text is restored only when untouched', async () => {
    const sketch = await map(owner);
    const mine = await thought(owner, sketch.id, 'Sensor rig');
    const run = await liveRun();
    const added = JSON.parse(text((await run.call('flux_add_thought', { mapId: sketch.id, thought: { text: 'Mount the lamp', x: 40, y: 40, linkFrom: { thoughtId: thoughtId(mine) } } })).message)) as { thoughtId: string; linkId: string };
    await run.call('flux_update_thought', { mapId: sketch.id, thoughtId: thoughtId(mine), expectedVersion: thoughtVersion(mine), changes: { text: 'Sensor rig v2' } });
    const page = JSON.parse(text((await run.call('flux_create_doc', { doc: { title: 'Mounting', body: 'How to mount' } })).message)) as { docId: string };
    await complete(run.runId);
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 3, undone.message);
    assert.ok(undone.changes.some((entry) => entry.change.objectType === 'doc' && entry.change.state === 'undone'), 'a page the assistant started is taken back (#1021)');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sketch_thoughts WHERE id = $1`, [added.thoughtId])).rows[0].n, 0, 'the created thought is removed');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sketch_links WHERE id = $1`, [added.linkId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT text FROM sketch_thoughts WHERE id = $1`, [thoughtId(mine)])).rows[0].text, 'Sensor rig');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_materials WHERE id = $1`, [page.docId])).rows[0].n, 0, 'the untouched page is gone');
  });

  test('AST-6.3: a worker killed after two committed changes leaves a message with exactly those two changes once recovery ends the run', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Committed one' } });
    await run.call('flux_create_task', { task: { title: 'Committed two' } });
    await pool.query(`UPDATE personal_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [run.runId]);
    assert.ok(await recoverPersonalRuns(personalRunWorkerUnitOfWork(db)) >= 1);
    const items = await listRun(run.runId);
    assert.equal(items.length, 2);
    assert.ok(items.every((change) => change.runState === 'failed' && change.undoable), 'a dead run still posts what it changed, with Undo');
    assert.equal(assistantChangeLine(items), 'Added task Committed one · added task Committed two');
  });

  test('AST-6.4: Stop makes the next tool call fail with 403 and keeps the committed changes, with Undo', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Before the stop one' } });
    await run.call('flux_create_task', { task: { title: 'Before the stop two' } });
    expectStatus(await owner.browser.request('POST', `/api/v1/assistant-runs/${run.runId}/stop`), 200);
    const refused = await run.call('flux_create_task', { task: { title: 'After the stop' } });
    assert.equal(refused.status, 403);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'After the stop' AND project_id = $1`, [place.id])).rows[0].n, 0);
    const items = await listRun(run.runId);
    assert.equal(items.length, 2);
    assert.ok(items.every((change) => change.runState === 'stopped'));
    assert.ok(items.every((change) => change.undoable));
  });

  test('AST-6.6: receipts record the owner, the agent, the engine and the run id; no log row or receipt holds a vendor credential', async () => {
    const run = await liveRun();
    await run.call('flux_create_task', { task: { title: 'Receipt check sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    await complete(run.runId);
    const [row] = await changesOf(run.runId);
    assert.deepEqual([row!.receipt!.ownerUserId, row!.receipt!.agentId, row!.receipt!.runId, typeof row!.receipt!.engine], [owner.id, agentId, run.runId, 'string']);
    assert.equal(row!.receipt!.payer, 'Anthropic API key', 'the connection the run is paid by');
    const everything = JSON.stringify((await pool.query(`SELECT * FROM assistant_changes WHERE run_id = $1`, [run.runId])).rows);
    assert.ok(!everything.includes('sk-ant-'), 'no seeded secret in the change log');
    assert.ok(!everything.includes(run.token), 'no run token in the change log');
  });

  test('AST-6.8: a request behind the working one waits in the lane and starts when it ends; others see nothing of it', async () => {
    const first = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy the project' });
    const behind = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Turn this into tasks' });
    assert.equal(behind.run.status, 'queued');
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
    const listedEffects = run.tools.filter((name) => !name.startsWith('flux_list') && !name.startsWith('flux_get') && !['flux_read_material', 'flux_search_project', 'flux_project_orientation', 'flux_changes_since', 'flux_read_web'].includes(name));
    for (const name of listedEffects) assert.ok(effects.has(name), name);
    assert.equal(listedEffects.length, ASSISTANT_RUN_EFFECT_TOOLS.length, '"Do it and tell me" lists every change tool');
    await complete(run.runId);
  });


  // ------------------------------------------------------------------------------------------------------------------
  // #68 closeout (founder direction 2026-10-29): the Undo of what no person can remove. The assistant takes back its own map,
  // recorded result and proposed decision in the same run Undo, only while nobody has used it. A run posts no message (#1063); a posted
  // message an agent takes back is a local client's (LC-2), through the same change path and the same Undo, one change at a time (C-18).

  const value = (response: { message: Message }) => JSON.parse(text(response.message)) as Record<string, string>;
  const undoOne = async (changeId: string, who: Person = owner) =>
    expectStatus(await who.browser.request('POST', assistantChangeActionPath(changeId, 'undo'), { body: {} }), 200) as { message: string | null };
  const reply = async (who: Person, conversationId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
  const stateOf = async (id: string) => (await pool.query(`SELECT state, decided_by, receipt FROM assistant_changes WHERE id = $1`, [id])).rows[0] as { state: string; decided_by: string | null; receipt: Record<string, unknown> };
  const count = async (table: string, id: string) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE id = $1`, [id])).rows[0].count);
  const taskFrom = async (who: Person, body: Record<string, unknown>) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body }), 201) as { id: string; version: number };

  /** Ada's Claude Code on her laptop: a local client of her own agent in this space, made once. */
  let laptop: Awaited<ReturnType<typeof agentConnection>> | null = null;
  const client = async () => {
    if (!laptop) laptop = await agentConnection(pool, owner.browser, (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Ada laptop', owner: 'self' } }), 201) as { id: string }).id, [place.id]);
    return laptop;
  };
  /** A message the local client posts, with the one change that records it. */
  const post = async (tool: 'flux_reply_in_conversation' | 'flux_start_conversation', args: Record<string, unknown>) => {
    const by = await client();
    const made = toolValue(await by.tool(tool, { projectId: place.id, clientCommandId: randomUUID(), sources: [], ...args }));
    const messageId = String(made.messageId); const conversationId = String(made.conversationId);
    const [change] = (await pool.query(`SELECT id, state, agent_id FROM assistant_changes WHERE connection_id = $1 AND object_id = $2`, [by.connectionId, messageId])).rows as
      { id: string; state: string; agent_id: string }[];
    assert.ok(change, `${tool} is one change of the client`);
    return { messageId, conversationId, change: change! };
  };

  test('#68 message: Undo takes a local client\'s reply back to a tombstone, attributed, with an ids-only event; it keeps its place', async () => {
    const posted = await post('flux_reply_in_conversation', { conversationId: thread.id, message: { body: 'Here is the summary of the sensor work' } });
    const change = posted.change;
    assert.equal(change.state, 'applied');
    const listed = (expectStatus(await owner.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items.find((item) => item.id === change.id);
    assert.equal(listed?.undoable, true, 'the message offers its owner Undo');
    const peerView = (expectStatus(await peer.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items.find((item) => item.id === change.id);
    assert.equal(peerView?.undoable, false, 'someone else who may edit sees it done, with no Undo of their own');
    assert.equal((await undoOne(change.id)).message, null);
    const row = (await pool.query(`SELECT body, removed_at, sequence, author_agent_id FROM project_messages WHERE id = $1`, [posted.messageId])).rows[0];
    assert.equal(row.body, '[Removed with Undo]');
    assert.ok(row.removed_at, 'the row stays, marked');
    assert.equal(row.author_agent_id, change.agent_id, 'still the agent\'s message');
    const seen = expectStatus(await peer.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
    const shown = seen.messages.find((message) => message.id === posted.messageId)!;
    assert.deepEqual([shown.body, typeof shown.removedAt], ['[Removed with Undo]', 'string'], 'readers get the marker and the time');
    const after = await stateOf(change.id);
    assert.deepEqual([after.state, after.decided_by], ['undone', owner.id], 'attributed to the person who undid it');
    const removed = (after.receipt.undone as { removed: Record<string, unknown> }).removed;
    assert.deepEqual(Object.keys(removed).sort(), ['bodyHash', 'bodyLength', 'conversationId', 'sequence'], 'the audit keeps a hash and a length, never the text');
    assert.equal(JSON.stringify(after.receipt).includes('summary of the sensor work'), false, 'the receipt holds no text');
    const events = (await pool.query(`SELECT data FROM events WHERE kind = 'project.assistant_change_undone.v1' AND data->>'objectId' = $1`, [posted.messageId])).rows;
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].data).sort(), ['changeId', 'objectId', 'objectType'], 'ids only');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE body ILIKE '%summary of the sensor work%'`)).rows[0].n, 0, 'no longer found by search');
  });

  test('#68 message: refused once anyone replied since or cited it, with the reason, and nothing changes', async () => {
    const first = await post('flux_reply_in_conversation', { conversationId: thread.id, message: { body: 'First point about the probes' } });
    await reply(peer, thread.id, 'Thanks, that helps');
    assert.equal((await undoOne(first.change.id)).message, 'Replies since. Open it');
    assert.equal((await stateOf(first.change.id)).state, 'applied');
    assert.equal((await pool.query(`SELECT removed_at FROM project_messages WHERE id = $1`, [first.messageId])).rows[0].removed_at, null);
    // Cited: a task started from it, with no later message in the thread (a conversation of its own).
    const started = await post('flux_start_conversation', { message: { body: 'A new question about the lamp driver' } });
    await taskFrom(peer, { title: 'Follow the lamp driver question', sources: [{ type: 'message', id: started.messageId }] });
    assert.equal((await undoOne(started.change.id)).message, 'Used since. Open it');
    assert.equal((await stateOf(started.change.id)).state, 'applied');
  });

  test('#68 message: each of a client\'s messages is its own Undo, and its own later reply is taken back first (C-18)', async () => {
    const a = await post('flux_start_conversation', { message: { body: 'Opening question from the laptop' } });
    const b = await post('flux_reply_in_conversation', { conversationId: a.conversationId, message: { body: 'My own follow-up' } });
    assert.equal((await undoOne(a.change.id)).message, 'Replies since. Open it', 'its own later reply counts until that is taken back first');
    assert.equal((await undoOne(b.change.id)).message, null);
    assert.equal((await undoOne(a.change.id)).message, null);
    const rows = (await pool.query(`SELECT id, removed_at FROM project_messages WHERE id = ANY($1)`, [[a.messageId, b.messageId]])).rows as { removed_at: Date | null }[];
    assert.ok(rows.every((message) => message.removed_at));
  });

  test('#68 map: Undo removes an untouched map the assistant made and refuses once renamed, filled or cited', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_map', { title: 'Probe layout' }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    assert.equal((await listRun(run.runId))[0]!.undoable, true);
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 1, undone.message);
    assert.equal(await count('sketches', made.mapId), 0, 'the map is gone');
    assert.deepEqual([(await stateOf(change!.id)).state, (await stateOf(change!.id)).decided_by], ['undone', owner.id]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'project.assistant_change_undone.v1' AND data->>'objectId' = $1`, [made.mapId])).rows[0].n, 1);

    const refusals: [string, (id: string) => Promise<unknown>, string][] = [
      ['renamed', async (id) => expectStatus(await peer.browser.request('PATCH', `/api/v1/sketches/${id}`, { body: { title: 'Probe layout v2' }, headers: { 'if-match': '"1"' } }), 200), 'Renamed since. Open it'],
      ['filled', async (id) => thought(peer, id, 'A thought from Jonas'), 'It has thoughts now. Open it'],
      ['cited', async (id) => taskFrom(peer, { title: 'Use the probe layout', related: [{ type: 'sketch', id }] }), 'Used since. Open it'],
    ];
    for (const [name, use, reason] of refusals) {
      const other = await liveRun();
      const kept = value(await other.call('flux_create_map', { title: 'Probe layout' }));
      await complete(other.runId);
      await use(kept.mapId);
      const [row] = await changesOf(other.runId);
      assert.equal((await undoOne(row!.id)).message, reason, name);
      assert.equal(await count('sketches', kept.mapId), 1, `${name}: the map stays`);
      assert.equal((await stateOf(row!.id)).state, 'applied', name);
    }
  });

  test('#68 decision: Undo removes a proposal nobody used and refuses once decided or cited', async () => {
    const affected = await task(owner, 'Choose the sensor');
    const run = await liveRun();
    const proposed = value(await run.call('flux_propose_decision', { decision: { title: 'Use the ToF sensor', rationale: 'It works in the dark', affects: [affected.id] } }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    assert.equal((await listRun(run.runId))[0]!.undoable, true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1`, [proposed.decisionId])).rows[0].n > 0, true, 'it affects the task');
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 1, undone.message);
    assert.equal(await count('project_decisions', proposed.decisionId), 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE kind = 'decision' AND object_id = $1`, [proposed.decisionId])).rows[0].n, 0, 'no longer found by search');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1`, [proposed.decisionId])).rows[0].n, 0, 'its own links go with it');
    assert.equal((await stateOf(change!.id)).state, 'undone');

    // Accepted by a person since.
    const accepted = await liveRun();
    const kept = value(await accepted.call('flux_propose_decision', { decision: { title: 'Use a camera', rationale: 'Cheaper' } }));
    await complete(accepted.runId);
    expectStatus(await owner.browser.request('POST', `/api/v1/decisions/${kept.decisionId}/accept`, { body: {}, headers: { 'if-match': `"${kept.version}"` } }), 200);
    const [acceptedRow] = await changesOf(accepted.runId);
    assert.equal((await undoOne(acceptedRow!.id)).message, 'Decided since. Open it');
    assert.equal(await count('project_decisions', kept.decisionId), 1);
    // Cited by a task since.
    const cited = await liveRun();
    const pinned = value(await cited.call('flux_propose_decision', { decision: { title: 'Use a lidar', rationale: 'Precise' } }));
    await complete(cited.runId);
    await taskFrom(peer, { title: 'Evaluate the lidar decision', related: [{ type: 'decision', id: pinned.decisionId }] });
    const [citedRow] = await changesOf(cited.runId);
    assert.equal((await undoOne(citedRow!.id)).message, 'Used since. Open it');
    assert.equal(await count('project_decisions', pinned.decisionId), 1);
  });

  test('#68 result: Undo removes the result, tombstones what it told the task and puts the finished task back; refused once replied to or the task changed', async () => {
    const target = await task(owner, 'Test the camera in low light');
    const run = await liveRun();
    const recorded = value(await run.call('flux_record_result', { result: { title: 'Camera fails below 5 lux', finding: 'negative', evidence: '20 gestures',
      workIds: [target.id], finishes: { workId: target.id, expectedVersion: target.version } } }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    assert.equal((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [target.id])).rows[0].status, 'done', 'the result finished the task');
    const told = (await pool.query(`SELECT id, conversation_id FROM project_messages WHERE result_id = $1`, [recorded.resultId])).rows as { id: string }[];
    assert.equal(told.length, 1, 'it told the task\'s discussion');
    assert.equal((await listRun(run.runId))[0]!.undoable, true);
    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 1, undone.message);
    assert.equal(await count('project_results', recorded.resultId), 0);
    assert.equal((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [target.id])).rows[0].status, 'open', 'the task is as it was');
    const message = (await pool.query(`SELECT body, removed_at, contribution_kind, result_id FROM project_messages WHERE id = $1`, [told[0]!.id])).rows[0];
    assert.deepEqual([message.body, message.contribution_kind, message.result_id], ['[Removed with Undo]', 'text', null]);
    assert.ok(message.removed_at);
    assert.equal((await stateOf(change!.id)).state, 'undone');

    // A person replied in the task's discussion since.
    const replied = await task(owner, 'Test the ToF sensor');
    const second = await liveRun();
    const keptA = value(await second.call('flux_record_result', { result: { title: 'ToF works in the dark', finding: 'positive', workIds: [replied.id], finishes: { workId: replied.id, expectedVersion: replied.version } } }));
    await complete(second.runId);
    expectStatus(await peer.browser.request('POST', `/api/v1/work/${replied.id}/discussion`, { body: { body: 'Great, thanks', clientMessageId: randomUUID() } }), 201);
    const [repliedRow] = await changesOf(second.runId);
    assert.equal((await undoOne(repliedRow!.id)).message, 'Replies since. Open it');
    assert.equal(await count('project_results', keptA.resultId), 1);
    assert.equal((await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [replied.id])).rows[0].status, 'done', 'nothing was half undone');

    // The finished task was changed since.
    const moved = await task(owner, 'Test the lidar');
    const third = await liveRun();
    const keptB = value(await third.call('flux_record_result', { result: { title: 'Lidar is too slow', finding: 'negative', workIds: [moved.id], finishes: { workId: moved.id, expectedVersion: moved.version } } }));
    await complete(third.runId);
    const current = (await pool.query(`SELECT version FROM project_work_items WHERE id = $1`, [moved.id])).rows[0].version as number;
    await patchWork(peer, moved.id, current, { status: 'in_progress' });
    const [movedRow] = await changesOf(third.runId);
    assert.equal((await undoOne(movedRow!.id)).message, 'The task changed since. Open it');
    assert.equal(await count('project_results', keptB.resultId), 1, 'the result stays with its task');
  });

  test('#68 Undo of these four follow the AI switch of their space: refused while AI is off, with nothing changed, and works again after', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_map', { title: 'Locked map' }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    await setSpaceAi(place.id, 'blocked');
    try {
      const refused = await owner.browser.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} });
      assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [403, 'SPACE_AI_OFF']);
      const all = await owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} });
      assert.deepEqual([all.status, (all.json as { code?: string }).code], [403, 'SPACE_AI_OFF']);
      assert.equal(await count('sketches', made.mapId), 1);
      assert.equal((await stateOf(change!.id)).state, 'applied');
    } finally { await ensureSpaceAiAllowed(place.id); }
    assert.equal((await undoRun(run.runId)).undone, 1);
    assert.equal(await count('sketches', made.mapId), 0);
  });

  test('#68 a stranger cannot take these back, and the change keeps its removal plan', async () => {
    const run = await liveRun();
    value(await run.call('flux_create_map', { title: 'A map only the owner may take back' }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    expectStatus(await stranger.browser.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} }), 404);
    assert.equal((await stateOf(change!.id)).state, 'applied');
    const row = (await pool.query(`SELECT receipt FROM assistant_changes WHERE id = $1`, [change!.id])).rows[0].receipt as { undo?: { plan: { kind: string } } };
    assert.equal(row.undo?.plan.kind, 'removal');
  });


  test('#68 only the assistant\'s owner takes these four back, not every editor of the project', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_map', { title: 'Owner only map' }));
    const proposed = value(await run.call('flux_propose_decision', { decision: { title: 'Owner only decision', rationale: 'x' } }));
    await complete(run.runId);
    const [mapChange, decisionChange] = await changesOf(run.runId);
    // Jonas may edit the project; Ada's assistant made these.
    const theirs = (expectStatus(await peer.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items.filter((item) => item.runId === run.runId);
    assert.deepEqual(theirs.map((item) => item.undoable), [false, false], 'no Undo is offered to an editor who is not the owner');
    assert.equal((await undoOne(mapChange!.id, peer)).message, 'Only ac-ada can take back what their agent made');
    const all = expectStatus(await peer.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
    assert.equal(all.undone, 0, 'the run Undo of an editor leaves them alone');
    assert.deepEqual([await count('sketches', made.mapId), await count('project_decisions', proposed.decisionId)], [1, 1]);
    assert.equal((await stateOf(decisionChange!.id)).state, 'applied');
    assert.equal((await undoRun(run.runId)).undone, 2, 'the owner takes both back');
  });

  /** Text typed into a page's shared copy and not saved yet, as the live editor sends it. */
  async function typeIntoSharedCopy(who: Person, docId: string) {
    const [session] = (await pool.query('SELECT id, expires_at FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [who.id])).rows;
    const [row] = (await pool.query('SELECT name, email FROM auth_users WHERE id = $1', [who.id])).rows;
    const context: SessionContext = { sessionId: session.id, expiresAt: session.expires_at, principal: { kind: 'human', id: who.id }, user: { id: who.id, ...row } };
    const authority = wikiAuthority({ pool });
    const copy = new Y.Doc();
    try {
      const head = await authority.bootstrap(context, docId);
      await authority.enroll(context, docId, { generation: head.generation, replicaId: copy.clientID });
      Y.applyUpdate(copy, Buffer.from(head.checkpoint, 'base64'));
      copy.getText('body').insert(head.body.length, ' Typed, not saved yet.');
      const envelope = { workspace: head.workspaceId, kind: 'wiki' as const, room: head.resourceId, generation: head.generation, actor: who.id, operation: 'text' as const,
        uuid: randomUUID(), replica: copy.clientID, parameters: null };
      const bytes = Y.encodeStateAsUpdate(copy);
      await authority.submit(context, docId, envelope, bytes, authority.reserve(bytes));
    } finally { copy.destroy(); await authority.close(); }
  }
  const pageRows = async (id: string) => Number((await pool.query(`SELECT count(*) FROM project_materials WHERE id = $1`, [id])).rows[0].count);

  test('#1021 page: Undo deletes a page only the assistant wrote and nothing names, as the owner, through the page delete', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_doc', { doc: { title: 'Probe notes', body: 'Measured twice' } }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    const listed = (await listRun(run.runId))[0]!;
    assert.deepEqual([listed.operation, listed.objectType, listed.objectId, listed.undoable], ['doc.create', 'doc', made.docId, true]);
    assert.equal((change!.receipt as { undo?: { plan: { kind: string } } }).undo?.plan.kind, 'removal');
    // Only the assistant's owner takes a page back; someone else who may edit sees it done, with no Undo of their own.
    const theirs = (expectStatus(await peer.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items.find((item) => item.id === change!.id);
    assert.equal(theirs?.undoable, false);
    assert.equal((await undoOne(change!.id, peer)).message, 'Only ac-ada can take back what their agent made');
    assert.equal(await pageRows(made.docId), 1);

    const undone = await undoRun(run.runId);
    assert.equal(undone.undone, 1, undone.message);
    assert.deepEqual([await pageRows(made.docId), (await stateOf(change!.id)).state, (await stateOf(change!.id)).decided_by], [0, 'undone', owner.id]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_material_versions WHERE material_id = $1`, [made.docId])).rows[0].n, 0, 'its versions went with it');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE kind = 'doc' AND object_id = $1`, [made.docId])).rows[0].n, 0, 'no longer found by search');
    expectStatus(await owner.browser.request('GET', `/api/v1/docs/${made.docId}`), 404);
    const events = (await pool.query(`SELECT kind, actor_id FROM events WHERE data->>'docId' = $1 OR data->>'objectId' = $1 ORDER BY seq`, [made.docId])).rows as { kind: string; actor_id: string }[];
    assert.deepEqual(events.map((event) => event.kind), ['project.doc_created.v1', 'project.doc_deleted.v1', 'project.assistant_change_undone.v1']);
    assert.equal(events[1]!.actor_id, `human:${owner.id}`, 'the delete is the owner\'s, under their rights');
    assert.equal((await undoOne(change!.id)).message, 'This one can’t be undone', 'a second Undo changes nothing');
  });

  test('#1021 page: a run that also edited its page takes both back; a page edited, named or being typed in by anyone else stays, with the reason', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_doc', { doc: { title: 'Wiring notes', body: 'First pass' } }));
    await run.call('flux_update_doc', { docId: made.docId, expectedVersion: Number(made.version), changes: { body: 'Second pass' } });
    await complete(run.runId);
    assert.equal((await listRun(run.runId)).filter((item) => item.undoable).length, 2);
    const both = await undoRun(run.runId);
    assert.equal(both.undone, 2, both.message);
    assert.equal(await pageRows(made.docId), 0, 'the edit is taken back first, as a version by the owner; the page is still the assistant\'s own');

    const refusals: [string, (id: string) => Promise<unknown>, string][] = [
      ['edited by a person', async (id) => expectStatus(await peer.browser.request('PATCH', `/api/v1/docs/${id}`, { body: { body: 'Jonas wrote this' }, headers: { 'if-match': '"1"' } }), 200), 'Changed since. Open it'],
      ['edited by its owner', async (id) => expectStatus(await owner.browser.request('PATCH', `/api/v1/docs/${id}`, { body: { title: 'Wiring notes, mine' }, headers: { 'if-match': '"1"' } }), 200), 'Changed since. Open it'],
      ['named by another page', async (id) => doc(peer, 'Index', `See [the wiring](flux:doc/${id}).`), 'Used since. Open it'],
      ['typed in and not saved', async (id) => typeIntoSharedCopy(peer, id), 'Changed since. Open it'],
    ];
    for (const [name, use, reason] of refusals) {
      const other = await liveRun();
      const kept = value(await other.call('flux_create_doc', { doc: { title: 'Wiring notes', body: 'First pass' } }));
      await complete(other.runId);
      await use(kept.docId);
      const [row] = await changesOf(other.runId);
      assert.equal((await undoOne(row!.id)).message, reason, name);
      assert.equal(await pageRows(kept.docId), 1, `${name}: the page stays`);
      assert.equal((await stateOf(row!.id)).state, 'applied', name);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'project.doc_deleted.v1' AND data->>'docId' = $1`, [kept.docId])).rows[0].n, 0, `${name}: nothing was deleted`);
    }
  });

  /** One page the assistant started in a finished run, and its change row. */
  async function agentPage(title: string) {
    const run = await liveRun();
    const made = value(await run.call('flux_create_doc', { doc: { title, body: 'Measured twice' } }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    return { docId: made.docId!, changeId: change!.id };
  }

  test('#1021 page: another agent\'s version keeps the page, whatever its reason says; so do a citing message, a suggestion, a plan item, a task made from it and a call held on it', async () => {
    // Another person's own agent edits the page with a reason that starts like the owner's Undo ("Undo: "): the reason decides nothing.
    const edited = await agentPage('Edited by Jonas\'s agent');
    const jonasAgent = (expectStatus(await peer.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Jonas Codex', owner: 'self' } }), 201) as { id: string }).id;
    const local = await agentConnection(pool, peer.browser, jonasAgent, [place.id]);
    const saved = await local.tool('flux_update_doc', { projectId: place.id, clientCommandId: randomUUID(), docId: edited.docId, expectedVersion: 1,
      changes: { body: 'Jonas\'s agent rewrote this with two new paragraphs.', reason: 'Undo: put the intro back the way Jonas wrote it' } });
    if (waits(saved)) await approveWaiting(pool, peer.browser, local.connectionId, 'doc.update');
    const versions = (await pool.query(`SELECT author_id, author_agent_id, reason FROM project_material_versions WHERE material_id = $1 ORDER BY version`, [edited.docId])).rows as
      { author_id: string | null; author_agent_id: string | null; reason: string }[];
    assert.deepEqual(versions.map((version) => [version.author_id, version.author_agent_id === agentId, version.reason.startsWith('Undo: ')]), [[null, true, false], [null, false, true]]);
    assert.equal((await undoOne(edited.changeId)).message, 'Changed since. Open it');
    assert.equal(await pageRows(edited.docId), 1, 'a version by another agent keeps the page');

    const cited = await agentPage('Cited by a message');
    expectStatus(await peer.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: { body: 'See the page.', clientMessageId: randomUUID(), source: { materialId: cited.docId, version: 1 } } }), 201);
    const suggested = await agentPage('Suggested from');
    await pool.query(`INSERT INTO agent_proposals (id, workspace_id, project_id, agent_id, owner_user_id, compute_source, source_material_id, source_material_version,
      client_command_id, request_fingerprint, fact, interpretation, suggested_action)
      VALUES ($1, $2, $3, $4, $5, 'user_operated_external_client', $6, 1, $7, $8, 'A fact', 'A reading', 'An action')`,
    [randomUUID(), ws.id, place.id, agentId, owner.id, suggested.docId, randomUUID(), 'a'.repeat(64)]);
    const planned = await agentPage('Planned from');
    const planTask = (await task(peer, 'Measure the bracket')).id;
    await pool.query(`INSERT INTO project_task_plan_intents (workspace_id, project_id, material_id, material_version, intent_key, task_id, creation_fingerprint, task_version)
      VALUES ($1, $2, $3, 1, 'measure', $4, $5, 1)`, [ws.id, place.id, planned.docId, planTask, 'b'.repeat(64)]);
    const sourced = await agentPage('Task made from');
    expectStatus(await peer.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Read it', sources: [{ type: 'material', id: sourced.docId, version: 1 }] } }), 201);
    const called = await agentPage('Call held here');
    const room = randomUUID();
    await pool.query(`INSERT INTO live_sessions (id, workspace_id, project_id, doc_id, created_by, client_session_id, room_id, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'available')`, [room, ws.id, place.id, called.docId, peer.id, randomUUID(), `live_${randomUUID()}`]);
    for (const [name, page] of [['a message that cited it', cited], ['an agent suggestion', suggested], ['a task plan item', planned], ['a task made from it', sourced], ['a call held on it', called]] as const) {
      assert.equal((await undoOne(page.changeId)).message, 'Used since. Open it', name);
      assert.equal(await pageRows(page.docId), 1, `${name}: the page stays`);
      assert.equal((await stateOf(page.changeId)).state, 'applied', name);
    }
    // The call ended (or was never started): nothing is held, and the page is the assistant's own again.
    await pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`, [room]);
    assert.equal((await undoOne(called.changeId)).message, null);
    assert.equal(await pageRows(called.docId), 0);
    assert.equal((await pool.query(`SELECT state, doc_id FROM live_sessions WHERE id = $1`, [room])).rows[0].doc_id, called.docId, 'the ended call keeps the page\'s id as history');
  });

  test('#1021 page: Undo of a page follows the AI switch of its space, like the other removals', async () => {
    const run = await liveRun();
    const made = value(await run.call('flux_create_doc', { doc: { title: 'Locked page', body: 'Text' } }));
    await complete(run.runId);
    const [change] = await changesOf(run.runId);
    await setSpaceAi(place.id, 'blocked');
    try {
      const refused = await owner.browser.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} });
      assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [403, 'SPACE_AI_OFF']);
      assert.equal(await pageRows(made.docId), 1);
    } finally { await ensureSpaceAiAllowed(place.id); }
    assert.equal((await undoRun(run.runId)).undone, 1);
    assert.equal(await pageRows(made.docId), 0);
  });

  /** Two requests started `offset` ms apart, the second one the other way round on `swap`. */
  const race = async <A, B>(first: () => Promise<A>, second: () => Promise<B>, offset: number, swap: boolean): Promise<[A, B]> => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!swap) return Promise.all([first(), wait(offset).then(second)]);
    const [b, a] = await Promise.all([second(), wait(offset).then(first)]);
    return [a, b];
  };
  const undoRequest = (changeId: string) => () => owner.browser.request('POST', assistantChangeActionPath(changeId, 'undo'), { body: {} });
  const noServerError = (label: string, ...statuses: number[]) => assert.ok(statuses.every((status) => status < 500), `${label}: ${statuses.join(', ')}`);
  /** The database's own deadlock counter must not move while `body` runs (the victim of a deadlock is also a 500, but not every victim is seen by the caller). */
  const withoutDeadlock = async (label: string, body: () => Promise<void>) => {
    const count = async () => Number((await pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
    const before = await count();
    await body();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the statistics are flushed about once a second
    assert.equal(await count(), before, `${label}: the database detected a deadlock`);
  };

  test('#68 races: Undo of a result against a reply in the task\'s discussion never deadlocks (staggered, both orders)', async () => withoutDeadlock('result and reply', async () => {
    const seen: string[] = [];
    for (const offset of [0, 2, 5, 10]) for (const swap of [false, true]) {
      const target = await task(owner, `Race task ${offset}${swap}`);
      const run = await liveRun();
      const rec = value(await run.call('flux_record_result', { result: { title: `Race result ${offset}`, finding: 'positive', workIds: [target.id], finishes: { workId: target.id, expectedVersion: target.version } } }));
      await complete(run.runId);
      const [change] = await changesOf(run.runId);
      const [undone, human] = await race(undoRequest(change!.id),
        () => peer.browser.request('POST', `/api/v1/work/${target.id}/discussion`, { body: { body: `Concurrent ${offset}`, clientMessageId: randomUUID() } }), offset, swap);
      noServerError(`offset ${offset} swap ${swap}`, undone.status, human.status);
      seen.push(`${undone.status}/${human.status}`);
      // Never half done: the result and the finished task agree.
      const removed = (await count('project_results', rec.resultId)) === 0;
      const status = (await pool.query(`SELECT status FROM project_work_items WHERE id = $1`, [target.id])).rows[0].status;
      assert.equal(status, removed ? 'open' : 'done', `offset ${offset}: result removed ${removed}, task ${status}`);
    }
    assert.ok(seen.length === 8);
  }));

  test('#68 races: a person citing the object while its Undo runs is refused or the Undo is; never both commit', async () => withoutDeadlock('citation and Undo', async () => {
    const trials: [string, (offset: number, swap: boolean) => Promise<void>][] = [
      ['decision', async (offset, swap) => {
        const run = await liveRun();
        const made = value(await run.call('flux_propose_decision', { decision: { title: `Race decision ${offset}`, rationale: 'x' } }));
        await complete(run.runId);
        const [change] = await changesOf(run.runId);
        const [undone, cited] = await race(undoRequest(change!.id), () => peer.browser.request('POST', `/api/v1/projects/${place.id}/work`,
          { body: { title: `Cites decision ${offset}`, related: [{ type: 'decision', id: made.decisionId }] } }), offset, swap);
        noServerError('decision', undone.status, cited.status);
        const gone = (await count('project_decisions', made.decisionId)) === 0;
        const links = Number((await pool.query(`SELECT count(*) FROM project_object_links WHERE to_id = $1`, [made.decisionId])).rows[0].count);
        assert.ok(!(gone && links > 0), `decision removed but cited: undo ${undone.status} ${JSON.stringify(undone.json)}, citation ${cited.status}`);
      }],
      ['map', async (offset, swap) => {
        const run = await liveRun();
        const made = value(await run.call('flux_create_map', { title: 'Race map' }));
        await complete(run.runId);
        const [change] = await changesOf(run.runId);
        const [undone, cited] = await race(undoRequest(change!.id), () => peer.browser.request('POST', `/api/v1/projects/${place.id}/work`,
          { body: { title: `Cites map ${offset}`, related: [{ type: 'sketch', id: made.mapId }] } }), offset, swap);
        noServerError('map', undone.status, cited.status);
        const gone = (await count('sketches', made.mapId)) === 0;
        const links = Number((await pool.query(`SELECT count(*) FROM project_object_links WHERE to_id = $1`, [made.mapId])).rows[0].count);
        assert.ok(!(gone && links > 0), `map removed but cited: undo ${undone.status}, citation ${cited.status}`);
      }],
      ['a local client\'s message sourced by a task', async (offset, swap) => {
        const made = await post('flux_start_conversation', { message: { body: `Race question ${offset}` } });
        const [undone, cited] = await race(undoRequest(made.change.id), () => peer.browser.request('POST', `/api/v1/projects/${place.id}/work`,
          { body: { title: `Sourced from ${offset}`, sources: [{ type: 'message', id: made.messageId }] } }), offset, swap);
        noServerError('message source', undone.status, cited.status);
        const removed = (await pool.query(`SELECT removed_at FROM project_messages WHERE id = $1`, [made.messageId])).rows[0].removed_at !== null;
        const links = Number((await pool.query(`SELECT count(*) FROM project_object_links WHERE to_id = $1`, [made.messageId])).rows[0].count);
        assert.ok(!(removed && links > 0), `message taken back but cited: undo ${undone.status}, citation ${cited.status}`);
      }],
    ];
    for (const [name, trial] of trials) for (const offset of [0, 3, 8]) for (const swap of [false, true]) {
      try { await trial(offset, swap); } catch (error) { throw new Error(`${name} offset ${offset} swap ${swap}: ${(error as Error).message}`); }
    }
  }));

  test('#68 races: citing a map while another person writes a thought on it never deadlocks (the Undo\'s lock order must not widen this)', async () => withoutDeadlock('cite map and thought', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      const mine = await map(owner);
      const offset = [0, 2, 5, 10][i % 4]!; const swap = i % 8 >= 4;
      const [written, cited] = await race(
        () => peer.browser.request('POST', `/api/v1/sketches/${mine.id}/thoughts`, { body: { text: `Thought ${i}`, x: 0, y: 0 } }),
        () => owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: `Cites map ${i}`, related: [{ type: 'sketch', id: mine.id }] } }),
        offset, swap);
      noServerError(`${offset}${swap ? 'S' : ''}`, written.status, cited.status);
      seen.push(`${written.status}/${cited.status}`);
    }
    assert.equal(seen.length, 16);
  }));

  test('#68 races: a thought written in the assistant\'s map while its Undo runs: no 5xx, and a map is never removed with a person\'s thought in it', async () => withoutDeadlock('Undo and thought', async () => {
    for (let i = 0; i < 12; i++) {
      const run = await liveRun();
      const made = value(await run.call('flux_create_map', { title: `Thought race map ${i}` }));
      await complete(run.runId);
      const [change] = await changesOf(run.runId);
      const offset = [0, 5, 10, 20][i % 4]!; const swap = i % 8 >= 4;
      const [undone, written] = await race(undoRequest(change!.id),
        () => peer.browser.request('POST', `/api/v1/sketches/${made.mapId}/thoughts`, { body: { text: `Late thought ${i}`, x: 0, y: 0 } }), offset, swap);
      noServerError(`${offset}${swap ? 'S' : ''}`, undone.status, written.status);
      const kept = await count('sketches', made.mapId);
      const thoughts = Number((await pool.query(`SELECT count(*) FROM sketch_thoughts WHERE sketch_id = $1`, [made.mapId])).rows[0].count);
      // Either the Undo won (no map, so the late thought was refused) or the thought did (the map stays, with it): never a thought lost with the map.
      if (written.status === 201) assert.deepEqual([kept, thoughts], [1, 1], `trial ${i}: a person's thought must keep its map (${undone.status} ${JSON.stringify(undone.json)})`);
      if (kept === 0) assert.ok(written.status >= 400, `trial ${i}: the thought was accepted into a map that is gone`);
    }
  }));

  test('#68 races: a page started from the assistant\'s decision or result, or mentioning it, while its Undo runs leaves no link to a removed object', async () => withoutDeadlock('docs and Undo', async () => {
    for (let i = 0; i < 12; i++) {
      const kind = (['from-decision', 'mention-decision', 'from-result', 'mention-map'] as const)[i % 4]!;
      const run = await liveRun();
      const target = await task(owner, `Doc race task ${i}`);
      let objectId = ''; let table = '';
      if (kind === 'from-decision' || kind === 'mention-decision') {
        objectId = value(await run.call('flux_propose_decision', { decision: { title: `Doc race decision ${i}`, rationale: 'x' } })).decisionId; table = 'project_decisions';
      } else if (kind === 'from-result') {
        objectId = value(await run.call('flux_record_result', { result: { title: `Doc race result ${i}`, finding: 'positive', workIds: [target.id] } })).resultId; table = 'project_results';
      } else {
        objectId = value(await run.call('flux_create_map', { title: `Doc race map ${i}` })).mapId; table = 'sketches';
      }
      await complete(run.runId);
      const [change] = await changesOf(run.runId);
      const body = kind === 'from-decision' ? { title: `Doc ${i}`, body: 'First', from: { type: 'decision', id: objectId } }
        : kind === 'from-result' ? { title: `Doc ${i}`, body: 'First', from: { type: 'result', id: objectId } }
        : { title: `Doc ${i}`, body: `See [it](flux:${kind === 'mention-map' ? 'sketch' : 'decision'}/${objectId})` };
      const offset = [0, 3, 8][i % 3]!; const swap = i % 2 === 1;
      const [undone, page] = await race(undoRequest(change!.id), () => peer.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body }), offset, swap);
      noServerError(`${kind} ${offset}${swap ? 'S' : ''}`, undone.status, page.status);
      const gone = (await count(table, objectId)) === 0;
      const links = Number((await pool.query(`SELECT count(*) FROM project_object_links WHERE to_id = $1`, [objectId])).rows[0].count);
      assert.ok(!(gone && links > 0), `${kind} ${offset}${swap ? 'S' : ''}: removed but linked (undo ${undone.status} ${JSON.stringify(undone.json)}, page ${page.status})`);
    }
  }));

  test('#68 races: accepting a decision while its Undo runs is a 404 or a refusal, never a 500, and never both', async () => {
    for (const offset of [0, 3, 8]) for (const swap of [false, true]) {
      const run = await liveRun();
      const made = value(await run.call('flux_propose_decision', { decision: { title: `Race accept ${offset}`, rationale: 'x' } })) as unknown as { decisionId: string; version: number };
      await complete(run.runId);
      const [change] = await changesOf(run.runId);
      const [undone, accepted] = await race(undoRequest(change!.id), () => owner.browser.request('POST', `/api/v1/decisions/${made.decisionId}/accept`,
        { body: {}, headers: { 'if-match': `"${made.version}"` } }), offset, swap);
      noServerError(`offset ${offset} swap ${swap}`, undone.status, accepted.status);
      const left = (await pool.query(`SELECT status FROM project_decisions WHERE id = $1`, [made.decisionId])).rows[0] as { status: string } | undefined;
      const undoneOk = (undone.json as { message?: string | null }).message === null;
      assert.ok(!(left?.status === 'accepted' && undoneOk), 'accepted and taken back');
      if (!left) assert.ok([404, 409].includes(accepted.status), `accept of a removed decision: ${accepted.status}`);
    }
    const run = await liveRun();
    const gone = value(await run.call('flux_propose_decision', { decision: { title: 'Gone then accepted', rationale: 'x' } })) as unknown as { decisionId: string; version: number };
    await complete(run.runId);
    await undoRun(run.runId);
    const late = await owner.browser.request('POST', `/api/v1/decisions/${gone.decisionId}/accept`, { body: {}, headers: { 'if-match': `"${gone.version}"` } });
    assert.equal(late.status, 404);
  });

});
