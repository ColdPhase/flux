import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  assistantChangeActionPath, assistantMessageHeader, assistantRunChangesActionPath, assistantRunChangesPath, ASSISTANT_UNIT_CREATE_VIEW,
  type AssistantChange, type AssistantRunUndone,
} from '@flux/contracts';
import { assistantHandoffRunId, type PersonalComputeResult } from '@flux/core';
import { db, pool } from './support/db.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { expectStatus, type Person } from './support/people.js';
import { assistantScene, changesOf, text, type AssistantScene, type Message } from './support/assistant-scene.js';
import { assistantChangeUseCases } from '../../apps/server/src/assistant/changes.js';

// F-027 A3/A4 (#403, #404): the owner's assistant hands a task to one of the owner's OWN external agents (AST-3 "Hand-offs between the owner's
// agents", the bounded co-work amendment of 2026-10-10), with the controls of AST-3.2, AST-5.2, AST-5.4 and AST-6.2: the run-private catalog,
// strict input, the recipient and separation rules, "Ask me first" and an owner Apply long after the run ended, Undo before and after the
// recipient started, and the held races. The recipient is a real OAuth connection with its own grant; no model, CLI or account is used.

let scene: AssistantScene;
type Recipient = Awaited<ReturnType<typeof recipient>>;
let codex: Recipient; let jonasAgent: Recipient;

/** One of `who`'s own agents, authorized through the real OAuth consent, working in the project, named the way its owner calls it. */
async function recipient(who: Person, name: string, designation: 'codex' | 'claude_code' | 'other' = 'codex') {
  const agent = (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
  expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${scene.place.id}/grants`, { body: { principal: { kind: 'agent', id: agent }, role: 'contributor' } }), 201);
  const connected = await agentConnection(pool, who.browser, agent, [scene.place.id]);
  await pool.query(`UPDATE agent_connections SET name = $2, client_designation = $3 WHERE id = $1`, [connected.connectionId, name, designation]);
  return { ...connected, agentId: agent };
}
const schemaRefused = (message: Message) => !!message?.error || (message?.result as { isError?: boolean } | undefined)?.isError === true;
const units = async (taskId: string) => (await pool.query(`SELECT * FROM cowork_units WHERE work_id = $1 ORDER BY created_at, id`, [taskId])).rows as
  { id: string; state: string; generation: number; version: number; role: string; assignment_connection_id: string; run_id: string; unit_key: string; lease_id: string | null }[];
const unitCount = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM cowork_units WHERE project_id = $1`, [scene.place.id])).rows[0].n);
const claim = (r: Recipient, grantId: string, unitId: string, expectedVersion: number) =>
  r.tool('flux_claim_unit', { projectId: scene.place.id, runtimeSessionId: r.runtimeSessionId, grantId, clientCommandId: randomUUID(), peerRequestClass: 'execute', unitId, expectedVersion });

describe('hand-offs from the owner\'s assistant to the owner\'s own agents (F-027 A3/A4, #403/#404)', () => {
  before(async () => {
    scene = await assistantScene('ah');
    codex = await recipient(scene.owner, 'Codex');
    jonasAgent = await recipient(scene.peer, 'Jonas Codex');
  });
  beforeEach(async () => { await scene.reset(); });

  const handoff = (live: Awaited<ReturnType<AssistantScene['liveRun']>>, task: { id: string; version: number }, key: string,
    options: { role?: 'execute' | 'review' | 'plan'; to?: string; extra?: Record<string, unknown>; command?: string } = {}) =>
    live.call('flux_create_unit', { ...(options.command ? { clientCommandId: options.command } : {}), peerRequestClass: options.role ?? 'execute', taskId: task.id, unitKey: key,
      expectedTaskVersion: task.version, assignmentConnectionId: options.to ?? codex.connectionId, parent: null, ...options.extra });

  test('AST-3.2: the run lists flux_create_unit with a strict private input (no bootstrap runtime or grant), while the ordinary external schema is unchanged', async () => {
    const live = await scene.liveRun();
    assert.ok(live.tools.includes('flux_create_unit'), 'listed under the Tasks switch');
    const listed = ((await live.raw('tools/list')).message?.result as { tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }[] }).tools
      .find((tool) => tool.name === 'flux_create_unit')!;
    assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), ['assignmentConnectionId', 'clientCommandId', 'expectedTaskVersion', 'parent', 'peerRequestClass', 'projectId', 'taskId', 'unitKey']);
    assert.equal(listed.inputSchema.additionalProperties, false);
    assert.ok(!('runtimeSessionId' in listed.inputSchema.properties) && !('grantId' in listed.inputSchema.properties) && !('sources' in listed.inputSchema.properties));
    assert.match(listed.description, /authority is this run: there is no bootstrap and no standing grant/);
    assert.ok(!listed.description.includes('flux_bootstrap'));
    // The same tool for an ordinary bearer keeps its public contract, bootstrap fields and description.
    const ordinary = ((await mcp(codex.accessToken, 1, 'tools/list')).message?.result as { tools: { name: string; description: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[] }).tools
      .find((tool) => tool.name === 'flux_create_unit')!;
    assert.ok(ordinary.inputSchema.required?.includes('runtimeSessionId') && ordinary.inputSchema.required.includes('grantId'));
    assert.match(ordinary.description, /live cowork\.unit\.create grant/);
    assert.ok(!ordinary.description.includes('authority is this run'));
    await scene.complete(live.runId);
    // Tasks on Only read: no hand-off tool, and a forced call is refused by the same switch.
    await scene.save({ areas: { tasks: 'read' } });
    const read = await scene.liveRun();
    assert.ok(!read.tools.includes('flux_create_unit'));
    assert.equal(JSON.parse(text((await handoff(read, { id: randomUUID(), version: 1 }, 'x')).message)).code, 'MCP_ENTRY_UNAVAILABLE');
  });

  test('AST-5.2/AST-6.2: the assistant opens a pending unit for the owner\'s own agent with no claim, the recipient needs its own grant to start, and the receipt keeps who did what', async () => {
    const task = await scene.task(scene.owner, 'Review the lamp plan');
    const live = await scene.liveRun();
    const made = JSON.parse(text((await handoff(live, task, 'codex-review', { role: 'execute' })).message)) as { status: string; unitId: string; state: string; version: number; runId: string; assignmentConnectionId: string };
    assert.deepEqual([made.status, made.state, made.version, made.assignmentConnectionId], ['created', 'pending', 1, codex.connectionId]);
    const assistantConnection = await scene.assistantConnectionId();
    assert.equal(made.runId, assistantHandoffRunId(assistantConnection, task.id, 'codex-review'), 'its own namespace, from the verified assistant connection');
    const [unit] = await units(task.id);
    assert.deepEqual([unit!.state, unit!.generation, unit!.lease_id], ['pending', 0, null], 'creation grants nobody a claim');
    const [row] = await changesOf(live.runId);
    assert.deepEqual([row!.operation, row!.state, row!.authority, row!.object_id], ['cowork.unit.create', 'applied', 'owner_request', task.id]);
    assert.equal(row!.receipt!.assistantConnectionId, assistantConnection);
    assert.equal(row!.receipt!.ownerUserId, scene.owner.id);
    assert.equal((row!.receipt!.undo as { plan: { kind: string; unitId: string } }).plan.unitId, unit!.id);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id = ANY($1)`, [[assistantConnection, codex.connectionId]])).rows[0].n), 0, 'no standing grant was made or used');
    // The recipient cannot start without its own grant and claim; with them it can, and the unit is then its own.
    const unclaimed = await claim(codex, randomUUID(), unit!.id, 1);
    assert.equal((unclaimed as { result?: { isError?: boolean } }).result?.isError, true);
    assert.deepEqual((await units(task.id)).map((item) => [item.state, item.generation]), [['pending', 0]]);
    const grant = await codex.grant('cowork.claim', 'execute', 5, unit!.id);
    assert.equal(toolValue(await claim(codex, grant.id, unit!.id, 1)).state, 'claimed');
    // The message: "Done: handed off 1 task", with where it stands, in the owner's words for the agent.
    await scene.complete(live.runId);
    const listed = (expectStatus(await scene.owner.browser.request('GET', assistantRunChangesPath(live.runId)), 200) as { items: AssistantChange[] }).items;
    assert.equal(assistantMessageHeader(listed), 'Done: handed off 1 task');
    assert.deepEqual([listed[0]!.after, listed[0]!.line], ['Handed to Codex', 'Codex started']);
  });

  test('AST-5.2: the same intent returns the same unit; a changed role or recipient conflicts; one open unit per role; a replay of the command is the stored outcome', async () => {
    const task = await scene.task(scene.owner, 'Plan the rig');
    const live = await scene.liveRun();
    const command = randomUUID();
    const first = JSON.parse(text((await handoff(live, task, 'one', { command })).message)) as { unitId: string; status: string };
    const replay = JSON.parse(text((await handoff(live, task, 'one', { command })).message)) as { unitId: string; replayed: boolean };
    assert.deepEqual([replay.unitId, replay.replayed], [first.unitId, true]);
    const again = JSON.parse(text((await handoff(live, task, 'one')).message)) as { unitId: string; status: string };
    assert.deepEqual([again.unitId, again.status], [first.unitId, 'existing'], 're-issued intent meets its unit, never a second root');
    assert.equal((await units(task.id)).length, 1);
    const log = await changesOf(live.runId);
    assert.deepEqual(log.map((item) => [item.state, (item.receipt!.undo ?? null) === null]), [['applied', false], ['applied', true]], 'an existing unit is not this change\'s to undo');
    const conflict = JSON.parse(text((await handoff(live, task, 'one', { role: 'plan' })).message)) as { code: string };
    assert.equal(conflict.code, 'COWORK_UNIT_CONFLICT');
    const taken = JSON.parse(text((await handoff(live, task, 'two')).message)) as { code: string };
    assert.equal(taken.code, 'COWORK_UNIT_TAKEN', 'one open unit per role on the task');
    assert.equal((await units(task.id)).length, 1);
    await scene.complete(live.runId);
  });

  test('AST-5.3/AST-3.2: another person\'s agent, the assistant itself, a revoked or unknown connection, a parent, forged authority and a closed or stale task are all refused with nothing written', async () => {
    const task = await scene.task(scene.owner, 'Calibrate the lens');
    const baseline = await unitCount();
    const retired = await recipient(scene.owner, 'Retired Codex');
    expectStatus(await scene.owner.browser.request('DELETE', `/api/v1/agent-connections/${retired.connectionId}`), 204);
    const live = await scene.liveRun();
    const refusals: [string, Message][] = [
      ['COWORK_ASSIGNEE_UNAVAILABLE', (await handoff(live, task, 'foreign', { to: jonasAgent.connectionId })).message],
      ['COWORK_ASSIGNEE_UNAVAILABLE', (await handoff(live, task, 'itself', { to: await scene.assistantConnectionId() })).message],
      ['COWORK_ASSIGNEE_UNAVAILABLE', (await handoff(live, task, 'revoked', { to: retired.connectionId })).message],
      ['COWORK_ASSIGNEE_UNAVAILABLE', (await handoff(live, task, 'unknown', { to: randomUUID() })).message],
    ];
    for (const [expected, message] of refusals) assert.equal(JSON.parse(text(message)).code, expected);
    // Forged authority and a parent are not part of the private input: refused before the adapter runs.
    for (const extra of [{ runtimeSessionId: randomUUID() }, { grantId: randomUUID() }, { ownerUserId: scene.owner.id }, { runId: live.runId }, { purpose: 'owner_approval' },
      { view: 'assistant-unit-create/v1' }, { maximumUses: 99 }, { sources: [] }, { parent: { unitId: randomUUID(), generation: 1, leaseId: randomUUID() } }]) {
      assert.ok(schemaRefused((await handoff(live, task, 'forged', { extra })).message), JSON.stringify(extra));
    }
    // A closed task, and a task that moved since the run read it (a person's change: "Skipped", never retried).
    const done = await scene.task(scene.owner, 'Already finished');
    await scene.patchWork(scene.owner, done.id, done.version, { status: 'done' });
    assert.equal(JSON.parse(text((await handoff(live, { id: done.id, version: done.version + 1 }, 'closed')).message)).code, 'COWORK_TASK_CLOSED');
    await scene.patchWork(scene.peer, task.id, task.version, { outcome: 'Changed by Jonas' });
    const stale = JSON.parse(text((await handoff(live, task, 'stale')).message)) as { code: string; error: string };
    assert.equal(stale.code, 'ASSISTANT_CHANGE_SKIPPED');
    assert.equal(stale.error, `Skipped #${task.number}: ah-jonas changed it while I worked`);
    assert.equal(await unitCount(), baseline + 0, 'no unit anywhere');
    assert.deepEqual((await changesOf(live.runId)).map((item) => item.state), ['refused'], 'only the skipped one is in the log');
    // In "Ask me first" a foreign recipient is refused at once too: nothing waits that no Apply could ever do.
    await scene.complete(live.runId);
    await scene.save({ approvalMode: 'ask' });
    const asking = await scene.liveRun();
    const fresh = await scene.task(scene.owner, 'Waits for nothing');
    assert.equal(JSON.parse(text((await handoff(asking, fresh, 'foreign-ask', { to: jonasAgent.connectionId })).message)).code, 'COWORK_ASSIGNEE_UNAVAILABLE');
    assert.deepEqual(await changesOf(asking.runId), []);
    await scene.complete(asking.runId);
  });

  test('AST-3.2: review is separated from execution across the whole task, not only the run; a stopped unit separates nothing', async () => {
    const task = await scene.task(scene.owner, 'Test the sensor');
    const second = await recipient(scene.owner, 'Claude Code', 'claude_code');
    const live = await scene.liveRun();
    assert.equal(JSON.parse(text((await handoff(live, task, 'run-it', { role: 'execute', to: codex.connectionId })).message)).status, 'created');
    assert.equal(JSON.parse(text((await handoff(live, task, 'check-it', { role: 'review', to: codex.connectionId })).message)).code, 'COWORK_REVIEW_SEPARATION', 'it would review its own execution');
    assert.equal(JSON.parse(text((await handoff(live, task, 'check-it', { role: 'review', to: second.connectionId })).message)).status, 'created', 'another agent may review');
    assert.equal((await units(task.id)).length, 2);
    // Cancelling the execution (Undo) leaves nothing that ran: the same agent may then review.
    const [first] = await changesOf(live.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(first!.id, 'undo'), { body: {} }), 200);
    const other = await scene.task(scene.owner, 'Review after cancel');
    await handoff(live, other, 'e', { role: 'execute', to: codex.connectionId });
    const [placed] = (await changesOf(live.runId)).filter((item) => item.object_id === other.id);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(placed!.id, 'undo'), { body: {} }), 200);
    assert.equal(JSON.parse(text((await handoff(live, other, 'r', { role: 'review', to: codex.connectionId })).message)).status, 'created');
    await scene.complete(live.runId);
  });

  test('AST-6.5/AST-6.4: a hand-off counts against the run\'s limit, and after Stop the next one is refused with 403 while independent recipient work goes on', async () => {
    const live = await scene.liveRun();
    for (let i = 1; i <= 20; i += 1) assert.ok(JSON.parse(text((await live.call('flux_create_task', { task: { title: `Limit task ${i}` } })).message)).workId);
    const task = await scene.task(scene.owner, 'Twenty-first change');
    assert.match(text((await handoff(live, task, 'limit')).message), /^Waiting for ah-ada's OK: hand off task #\d+ Twenty-first change\.$/);
    assert.equal((await changesOf(live.runId)).at(-1)!.wait_reason, 'limit');
    await scene.complete(live.runId);
    const running = await scene.liveRun();
    const mine = await scene.task(scene.owner, 'Stopped after one');
    const stopper = await recipient(scene.owner, 'Codex two');
    const made = JSON.parse(text((await handoff(running, mine, 'k', { to: stopper.connectionId })).message)) as { unitId: string };
    const grant = await stopper.grant('cowork.claim', 'execute', 5, made.unitId);
    assert.equal(toolValue(await claim(stopper, grant.id, made.unitId, 1)).state, 'claimed');
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${running.runId}/stop`), 200);
    const next = await scene.task(scene.owner, 'After the stop');
    assert.equal((await handoff(running, next, 'k2', { to: stopper.connectionId })).status, 403);
    assert.deepEqual((await units(mine.id)).map((item) => [item.state, item.generation]), [['claimed', 1]], 'the recipient\'s own work is not touched');
    assert.equal((await units(next.id)).length, 0);
  });

  test('AST-5.2: "Ask me first" stores the exact private intent; Apply after the run and its token ended makes exactly one unit under owner_approval with no model or CLI call', async () => {
    await scene.save({ approvalMode: 'ask' });
    const task = await scene.task(scene.owner, 'Hand me over later');
    const live = await scene.liveRun();
    const baseline = await unitCount();
    assert.match(text((await handoff(live, task, 'later')).message), /^Waiting for ah-ada's OK: hand off task #\d+ Hand me over later\.$/);
    assert.equal(await unitCount(), baseline, 'proposed is not created');
    const [row] = await changesOf(live.runId);
    assert.deepEqual([row!.state, row!.wait_reason, row!.prepared_command!.tool, row!.prepared_command!.view], ['waiting', 'ask', 'flux_create_unit', ASSISTANT_UNIT_CREATE_VIEW]);
    assert.deepEqual(Object.keys(row!.prepared_command!.args).sort(), ['assignmentConnectionId', 'clientCommandId', 'expectedTaskVersion', 'parent', 'peerRequestClass', 'projectId', 'taskId', 'unitKey']);
    await scene.complete(live.runId);
    const runs = Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n);
    const dispatched = scene.compute.dispatched.length;
    const applied = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: { expectedVersion: row!.version } }), 200) as { change: AssistantChange };
    assert.equal(applied.change.state, 'applied_after_wait');
    assert.equal(applied.change.line, 'Approved by ah-ada');
    const [unit] = await units(task.id);
    assert.deepEqual([unit!.state, unit!.generation, unit!.assignment_connection_id], ['pending', 0, codex.connectionId]);
    const [after] = await changesOf(live.runId);
    assert.deepEqual([after!.authority, after!.decided_by], ['owner_approval', scene.owner.id]);
    assert.equal(after!.receipt!.approvedBy, scene.owner.id);
    assert.equal(after!.receipt!.preparedBy, scene.agentId);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n), runs, 'no run was made or revived');
    assert.equal(scene.compute.dispatched.length, dispatched, 'no provider call');
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [live.runId])).rows[0].status, 'completed');
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 409);
    assert.equal((await units(task.id)).length, 1, 'a replay creates nothing more');
    // Undo still works on the approved hand-off: it is an ordinary conditional Undo.
    const undone = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(row!.id, 'undo'), { body: {} }), 200) as { change: AssistantChange; message: string | null };
    assert.equal(undone.change.state, 'undone');
    assert.equal((await units(task.id))[0]!.state, 'stopped');
  });

  test('AST-5.4: a saved hand-off does not survive a revoked or narrowed recipient, an unknown stored view, an altered payload or a switch turned off', async () => {
    await scene.save({ approvalMode: 'ask' });
    const live = await scene.liveRun();
    const prepare = async (title: string, key: string, to: Recipient) => {
      const task = await scene.task(scene.owner, title);
      await handoff(live, task, key, { to: to.connectionId });
      return { task, row: (await changesOf(live.runId)).find((item) => item.object_id === task.id)! };
    };
    const revoked = await recipient(scene.owner, 'Codex three');
    const narrowed = await recipient(scene.owner, 'Codex four');
    const unknown = await recipient(scene.owner, 'Codex five');
    const altered = await recipient(scene.owner, 'Codex six');
    const off = await recipient(scene.owner, 'Codex seven');
    const cases = {
      revoked: await prepare('Revoked recipient', 'a', revoked), narrowed: await prepare('Narrowed recipient', 'b', narrowed),
      unknown: await prepare('Unknown view', 'c', unknown), altered: await prepare('Altered payload', 'd', altered), off: await prepare('Switch off', 'e', off),
    };
    await scene.complete(live.runId);
    expectStatus(await scene.owner.browser.request('DELETE', `/api/v1/agent-connections/${revoked.connectionId}`), 204);
    await pool.query(`DELETE FROM agent_connection_projects WHERE connection_id = $1 AND project_id = $2`, [narrowed.connectionId, scene.place.id]);
    await pool.query(`UPDATE assistant_changes SET prepared_command = jsonb_set(prepared_command, '{view}', '"assistant-unit-create/v2"') WHERE id = $1`, [cases.unknown.row.id]);
    await pool.query(`UPDATE assistant_changes SET prepared_command = jsonb_set(prepared_command, '{args,unitKey}', '"other-key"') WHERE id = $1`, [cases.altered.row.id]);
    for (const [name, { row, task }] of Object.entries(cases)) {
      if (name === 'off') continue;
      const response = await scene.owner.browser.request('POST', assistantChangeActionPath(row.id, 'apply'), { body: { expectedVersion: row.version } });
      assert.ok(response.status >= 400 && response.status < 500, `${name}: refused (${response.status})`);
      assert.equal((await units(task.id)).length, 0, `${name}: no unit`);
      assert.equal((await pool.query(`SELECT state FROM assistant_changes WHERE id = $1`, [row.id])).rows[0].state, 'refused', name);
    }
    // The Tasks switch turned to Only read invalidates what was waiting, and turning it on again cannot revive it.
    await scene.save({ areas: { tasks: 'read' } });
    assert.equal((await pool.query(`SELECT state FROM assistant_changes WHERE id = $1`, [cases.off.row.id])).rows[0].state, 'refused');
    await scene.save({ areas: { tasks: 'edit' } });
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(cases.off.row.id, 'apply'), { body: {} }), 409);
    assert.equal((await units(cases.off.task.id)).length, 0);
  });

  test('AST-6.2: Undo cancels an untouched hand-off and the intent cannot be recreated; after the recipient started it changes nothing and says so truthfully', async () => {
    const early = await scene.task(scene.owner, 'Cancelled early');
    const late = await scene.task(scene.owner, 'Started already');
    const starter = await recipient(scene.owner, 'Codex eight');
    const live = await scene.liveRun();
    const command = randomUUID();
    const created = JSON.parse(text((await handoff(live, early, 'k', { command })).message)) as { unitId: string };
    const lateMade = JSON.parse(text((await handoff(live, late, 'k', { to: starter.connectionId })).message)) as { unitId: string };
    const [earlyRow, lateRow] = await changesOf(live.runId);
    // Before start: cancelled, and the same intent meets the same (stopped) unit.
    const undone = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(earlyRow!.id, 'undo'), { body: {} }), 200) as { change: AssistantChange; message: string | null };
    assert.deepEqual([undone.change.state, undone.message], ['undone', null]);
    const [cancelled] = await units(early.id);
    assert.deepEqual([cancelled!.state, cancelled!.generation, cancelled!.version], ['stopped', 1, 2], 'the row, its audit and run count remain');
    assert.equal((await codex.tool('flux_claim_unit', { projectId: scene.place.id, runtimeSessionId: codex.runtimeSessionId, grantId: (await codex.grant('cowork.claim', 'execute', 5, created.unitId)).id,
      clientCommandId: randomUUID(), peerRequestClass: 'execute', unitId: created.unitId, expectedVersion: 2 }) as { result?: { isError?: boolean } }).result?.isError, true, 'a cancelled unit cannot be claimed');
    const replay = JSON.parse(text((await handoff(live, early, 'k', { command: randomUUID() })).message)) as { unitId: string; status: string; state: string };
    assert.deepEqual([replay.unitId, replay.status, replay.state], [created.unitId, 'existing', 'stopped'], 'a replay cannot recreate or resurrect it');
    assert.equal((await units(early.id)).length, 1);
    // The retry of the original command after Undo says what happened, not "waiting".
    const retried = await handoff(live, early, 'k', { command });
    assert.equal(text(retried.message), 'Your owner undid this change');
    assert.equal((await units(early.id)).length, 1);
    await scene.complete(live.runId);
    // After start: nothing changes. The recipient's claim, lease and grants are exactly as they were.
    const grant = await starter.grant('cowork.claim', 'execute', 5, lateMade.unitId);
    const claimed = toolValue(await claim(starter, grant.id, lateMade.unitId, 1)) as { lease: { id: string }; generation: number };
    const before = (await units(late.id))[0]!;
    const refused = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(lateRow!.id, 'undo'), { body: {} }), 200) as { change: AssistantChange; message: string | null };
    assert.equal(refused.message, 'Your Codex already started. Open the task');
    assert.equal(refused.change.state, 'applied');
    const after = (await units(late.id))[0]!;
    assert.deepEqual([after.state, after.generation, after.version, after.lease_id], [before.state, before.generation, before.version, claimed.lease.id]);
    assert.equal(Number((await pool.query(`SELECT used FROM agent_standing_grants WHERE id = $1`, [grant.id])).rows[0].used), 1, 'the recipient\'s grant and its use are untouched');
    // As a whole message: one that cannot be taken back is reported with the rest.
    const all = expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(live.runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
    assert.equal(all.undone, 0);
    assert.deepEqual(all.changedSince, [`#${late.number}`]);
  });

  test('AST-6.2 held: a claim and an Undo serialize on the unit; whichever wins, the other sees its result whole and the recipient\'s authority is never reset', async () => {
    const wins = await scene.task(scene.owner, 'Claim wins');
    const loses = await scene.task(scene.owner, 'Undo wins');
    const a = await recipient(scene.owner, 'Codex nine');
    const b = await recipient(scene.owner, 'Codex ten');
    const live = await scene.liveRun();
    const claimWins = JSON.parse(text((await handoff(live, wins, 'k', { to: a.connectionId })).message)) as { unitId: string };
    const undoWins = JSON.parse(text((await handoff(live, loses, 'k', { to: b.connectionId })).message)) as { unitId: string };
    await scene.complete(live.runId);
    const [claimRow, undoRow] = await changesOf(live.runId);
    // (1) The claim commits first while the Undo waits on the unit row: the Undo then finds it started and changes nothing.
    let held = await scene.holding(`SELECT id FROM cowork_units WHERE id = $1 FOR UPDATE`, [claimWins.unitId]);
    const lost = await held.racing(() => scene.owner.browser.request('POST', assistantChangeActionPath(claimRow!.id, 'undo'), { body: {} }),
      (query) => query(`UPDATE cowork_units SET state = 'claimed', generation = 1, version = 2, lease_id = $2, lease_session_id = 'session', lease_expires_at = now() + interval '5 minutes' WHERE id = $1`,
        [claimWins.unitId, randomUUID()]));
    assert.equal((lost.json as { message: string }).message, 'Your Codex already started. Open the task');
    assert.deepEqual((await units(wins.id)).map((item) => [item.state, item.generation, item.version]), [['claimed', 1, 2]]);
    // (2) The Undo commits first while the real claim waits on the unit row: the claim then finds it stopped and is refused.
    const grant = await b.grant('cowork.claim', 'execute', 5, undoWins.unitId);
    held = await scene.holding(`SELECT id FROM cowork_units WHERE id = $1 FOR UPDATE`, [undoWins.unitId]);
    const claiming = await held.racing(() => claim(b, grant.id, undoWins.unitId, 1), (query) => query(`UPDATE cowork_units SET state = 'stopped', generation = 1, version = 2 WHERE id = $1`, [undoWins.unitId]));
    assert.equal((claiming as { result?: { isError?: boolean } }).result?.isError, true);
    assert.deepEqual((await units(loses.id)).map((item) => [item.state, item.lease_id]), [['stopped', null]], 'no claim, no lease');
    // The Undo itself then reads it as changed (someone stopped it), without touching anything else.
    const after = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(undoRow!.id, 'undo'), { body: {} }), 200) as { message: string | null; change: AssistantChange };
    assert.equal(after.change.state, 'applied');
    assert.equal(after.message, 'Changed since. Open it');
  });

  test('AST-5.2 held: a recipient revoked while the hand-off waits for the unit creation lock wins; no unit, no log row', async () => {
    const task = await scene.task(scene.owner, 'Revoke wins');
    const doomed = await recipient(scene.owner, 'Codex eleven');
    const live = await scene.liveRun();
    const held = await scene.holding(`SELECT id FROM agent_connections WHERE id = $1 FOR UPDATE`, [doomed.connectionId]);
    const creating = await held.racing(() => handoff(live, task, 'k', { to: doomed.connectionId }), (query) => query(`UPDATE agent_connections SET revoked_at = now() WHERE id = $1`, [doomed.connectionId]));
    assert.equal(JSON.parse(text(creating.message)).code, 'COWORK_ASSIGNEE_UNAVAILABLE');
    assert.equal((await units(task.id)).length, 0);
    assert.deepEqual(await changesOf(live.runId), []);
    await scene.complete(live.runId);
  });

  test('AST-5.4 held: an Apply of a saved hand-off loses to a recipient revoked while it waits; no unit, no approval recorded', async () => {
    await scene.save({ approvalMode: 'ask' });
    const doomed = await recipient(scene.owner, 'Codex thirteen');
    const task = await scene.task(scene.owner, 'Revoked during Apply');
    const live = await scene.liveRun();
    await handoff(live, task, 'k', { to: doomed.connectionId });
    await scene.complete(live.runId);
    const [row] = await changesOf(live.runId);
    const held = await scene.holding(`SELECT id FROM agent_connections WHERE id = $1 FOR UPDATE`, [doomed.connectionId]);
    const response = await held.racing(() => scene.owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: { expectedVersion: row!.version } }),
      (query) => query(`UPDATE agent_connections SET revoked_at = now() WHERE id = $1`, [doomed.connectionId]));
    assert.ok(response.status >= 400 && response.status < 500, `refused (${response.status})`);
    assert.equal((await units(task.id)).length, 0);
    const [after] = await changesOf(live.runId);
    assert.deepEqual([after!.state, after!.authority, after!.receipt], ['refused', null, null]);
  });

  test('AST-3.2 (both engines): a fake provider on the `server` engine prepares the same private intent through the worker\'s tool loop, and the plain result reaches it', async () => {
    await scene.save({ approvalMode: 'ask' });
    const task = await scene.task(scene.owner, 'Server engine hand-off');
    const input = { clientCommandId: randomUUID(), peerRequestClass: 'review', taskId: task.id, unitKey: 'server', expectedTaskVersion: task.version,
      assignmentConnectionId: codex.connectionId, parent: null };
    const replies: PersonalComputeResult[] = [
      { kind: 'completed' as const, text: 'handing', stopReason: 'tool_use', usage: { inputTokens: 300, outputTokens: 20 }, toolCalls: [{ id: 'c1', name: 'flux_create_unit', input }] },
      { kind: 'completed' as const, text: 'Asked Ada first.', stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 20 } },
    ];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke({ kind: 'human', id: scene.owner.id }, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Ask my Codex to review it' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    const toolTurn = JSON.stringify(scene.compute.dispatched[1]?.turns ?? []);
    assert.ok(toolTurn.includes('Waiting for ah-ada') && toolTurn.includes('hand off task'), 'the provider got the plain result');
    const [row] = await changesOf(started.run.id);
    assert.deepEqual([row!.state, row!.prepared_command!.view, row!.prepared_command!.args.assignmentConnectionId, row!.prepared_command!.args.peerRequestClass],
      ['waiting', ASSISTANT_UNIT_CREATE_VIEW, codex.connectionId, 'review']);
    const dispatched = scene.compute.dispatched.length;
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 200);
    assert.equal(scene.compute.dispatched.length, dispatched, 'Apply runs no engine');
    assert.deepEqual((await units(task.id)).map((item) => [item.role, item.state]), [['review', 'pending']]);
  });

  test('AST-3.2: an ordinary external caller cannot reach the adapter: the root rule, the bootstrap fields and the grant requirement are unchanged', async () => {
    const task = await scene.task(scene.owner, 'Ordinary caller');
    const grant = await codex.grant('cowork.unit.create', 'execute', 5, task.id);
    const base = { projectId: scene.place.id, runtimeSessionId: codex.runtimeSessionId, grantId: grant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute',
      taskId: task.id, unitKey: 'ordinary', expectedTaskVersion: task.version, parent: null };
    // A root for another connection of the same owner: the ordinary rule still refuses it (only its own assignee opens a run).
    const other = await recipient(scene.owner, 'Codex twelve');
    assert.equal(toolFailure(await codex.tool('flux_create_unit', { ...base, assignmentConnectionId: other.connectionId })).code, 'COWORK_ASSIGNMENT_REFUSED');
    // The private shape (no runtime or grant) is not accepted from an ordinary bearer; nothing is written.
    const privateShape: Record<string, unknown> = { ...base };
    delete privateShape.runtimeSessionId; delete privateShape.grantId;
    const baseline = await unitCount();
    assert.ok(schemaRefused(await codex.tool('flux_create_unit', { ...privateShape, assignmentConnectionId: codex.connectionId })));
    assert.equal(await unitCount(), baseline);
    // Its own root with its own grant still works, as before.
    const own = toolValue(await codex.tool('flux_create_unit', { ...base, clientCommandId: randomUUID(), assignmentConnectionId: codex.connectionId })) as { status: string };
    assert.equal(own.status, 'created');
    assert.equal(Number((await pool.query(`SELECT used FROM agent_standing_grants WHERE id = $1`, [grant.id])).rows[0].used), 1, 'the external creator still spends its own grant');
  });

  test('AST-3.2/AST-5.4: owner Apply and the run share the use cases; another owner, an admin or a stranger cannot approve a hand-off', async () => {
    await scene.save({ approvalMode: 'ask' });
    const task = await scene.task(scene.owner, 'Only Ada approves');
    const live = await scene.liveRun();
    await handoff(live, task, 'k');
    await scene.complete(live.runId);
    const [row] = await changesOf(live.runId);
    const baseline = await unitCount();
    for (const who of [scene.peer, scene.admin, scene.outsider, scene.viewer, scene.guest, scene.stranger]) {
      assert.equal((await who.browser.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} })).status, 404);
    }
    assert.equal(await unitCount(), baseline);
    const view = await assistantChangeUseCases(db).forRun({ kind: 'human', id: scene.owner.id }, live.runId);
    assert.equal(view.items[0]!.phrase, 'hand off task');
    assert.equal(view.items[0]!.verb, 'Hand off');
  });
});
