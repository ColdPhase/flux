import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  assistantChangeActionPath, assistantMessageHeader, assistantRunChangesActionPath, assistantRunChangesPath, conversationAssistantActivityPath,
  conversationAssistantChangesPath, NEEDS_YOU_PATH, ASSISTANT_WORKING_EVENT, PERSONAL_RUN_CONSENT_VERSION, type AssistantActivity, type AssistantChange,
  type AssistantRun, type AssistantRunUndone, type NeedsYouResponse,
} from '@flux/contracts';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { assistantChangeUseCases, reexecuteChange } from '../../apps/server/src/assistant/changes.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { agentConnection } from './support/mcp-actions.js';
import { expectStatus, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';
import { assistantScene, changesOf, DAY, human, text, type AssistantScene } from './support/assistant-scene.js';
import { waitFor } from './support/wait.js';

// F-027 A3/A4 (#403, #404), the parts the first slices left: who may decide a waiting change and who may undo what was done (negative controls),
// what an Apply repeats and what it may not do (held races against Not now, expiry, Stop, S6 and a revoked grant), the Apply allowance, Undo of
// done-when, prerequisites, waiting-for and a map's name, Undo by anyone who may edit, the owner's lane with a background run, and the working
// line everyone sees. A fake clock and fake engines stand in for every vendor; no model, CLI or account is used.

const human_ = human;
let scene: AssistantScene;
const run = (method: string, path: string, who: Person, body: unknown = {}) => who.browser.request(method, path, { body });
const apply = (who: Person, id: string, body: unknown = {}) => run('POST', assistantChangeActionPath(id, 'apply'), who, body);
const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const rowOf = async (id: string) => (await pool.query(`SELECT * FROM assistant_changes WHERE id = $1`, [id])).rows[0] as Awaited<ReturnType<typeof changesOf>>[number] & { expires_at: Date };
/** The assistant's agent's own grant in the project, replaced by `role` (or removed) for the length of one check. */
async function assistantGrant(role: 'denied' | null) {
  const before = (await pool.query(`SELECT id, role FROM project_grants WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId])).rows as { id: string; role: string }[];
  await pool.query(`DELETE FROM project_grants WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId]);
  if (role) await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, agent_id, role, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), scene.ws.id, scene.place.id, scene.agentId, role, scene.owner.id]);
  return async () => {
    await pool.query(`DELETE FROM project_grants WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId]);
    for (const grant of before) await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, agent_id, role, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), scene.ws.id, scene.place.id, scene.agentId, grant.role, scene.owner.id]);
  };
}

let assistantConnectionOfScene = '';
const assistantConnectionOf = () => assistantConnectionOfScene;
describe('the assistant\'s waiting changes and Undo: who may, and what may not happen (F-027 A3/A4, #403/#404)', () => {
  before(async () => { scene = await assistantScene('aa'); assistantConnectionOfScene = await scene.assistantConnectionId(); });
  beforeEach(async () => { await scene.reset(); });

  /** One change waiting for the owner: Jonas's task, which the owner's assistant may not change without her OK. */
  async function waiting(title = 'Jonas calibrates the probes') {
    const theirs = await scene.task(scene.peer, title);
    const live = await scene.liveRun();
    const prepared = await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { status: 'done' } });
    assert.match(text(prepared.message), /^Waiting for /);
    await scene.complete(live.runId);
    const [row] = await changesOf(live.runId);
    return { theirs, live, row: row! };
  }

  test('AST-5.5: only the owner reads, applies, declines, sends or moves a waiting change; another member, an admin, a viewer, a guest, a stranger, an agent and a run token are refused', async () => {
    const { theirs, live, row } = await waiting();
    const outside = [scene.peer, scene.outsider, scene.admin, scene.viewer, scene.guest, scene.stranger];
    for (const who of outside) {
      for (const action of ['apply', 'not-now', 'send', 'undo'] as const)
        assert.equal((await run('POST', assistantChangeActionPath(row.id, action), who)).status, 404, `${action} by someone else`);
      for (const action of ['apply', 'not-now', 'inbox', 'undo'] as const)
        assert.equal((await run('POST', assistantRunChangesActionPath(live.runId, action), who)).status, 404, `${action} of the run by someone else`);
      assert.equal((await who.browser.request('GET', assistantRunChangesPath(live.runId))).status, 404);
      assert.ok(!(expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.some((item) => item.key === `assistant:${live.runId}`));
      const listed = await who.browser.request('GET', conversationAssistantChangesPath(scene.thread.id));
      if (who === scene.stranger) assert.equal(listed.status, 404, 'not even a conversation of a project they cannot read');
      else assert.ok(!(expectStatus(listed, 200) as { items: AssistantChange[] }).items.some((change) => change.id === row.id), 'a waiting change is never in another person\'s list');
    }
    // An agent's bearer and the run's own (closed) token are not a session: neither can decide anything.
    const codexAgent = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada Codex', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${scene.place.id}/grants`, { body: { principal: { kind: 'agent', id: codexAgent }, role: 'contributor' } }), 201);
    const codex = await agentConnection(pool, scene.owner.browser, codexAgent, [scene.place.id]);
    for (const bearer of [codex.accessToken, live.token]) {
      const response = await fetch(`${apiUrl}${assistantChangeActionPath(row.id, 'apply')}`, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}' });
      assert.ok(response.status === 401 || response.status === 403, `a bearer is refused (${response.status})`);
    }
    const after = await rowOf(row.id);
    assert.deepEqual([after.state, after.version], ['waiting', row.version], 'nothing moved');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
    // The owner can still decide it.
    expectStatus(await apply(scene.owner, row.id, { expectedVersion: row.version }), 200);
    assert.equal((await scene.taskRow(theirs.id)).status, 'done');
  });

  test('AST-5.4/5.5: a stopped or failed source supplies no authority; Apply is refused, closed, and never revived', async () => {
    for (const end of [`status = 'stopped', stop_requested_at = now()`, `status = 'provider_failed'`] as const) {
      const { theirs, live, row } = await waiting(`Jonas aligns ${randomUUID().slice(0, 4)}`);
      await pool.query(`UPDATE personal_runs SET ${end}, completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [live.runId]);
      const refused = await apply(scene.owner, row.id, { expectedVersion: row.version });
      assert.equal(refused.status, 403, end);
      assert.equal(code(refused), 'ASSISTANT_CHANGE_INVALIDATED');
      assert.equal((await rowOf(row.id)).state, 'refused');
      assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
      assert.equal((await apply(scene.owner, row.id)).status, 409, 'a closed intent needs Ask again');
    }
  });

  test('AST-5.4: a paused assistant blocks Apply; after the owner resumes it, the same unchanged item still needs a fresh Apply', async () => {
    const { theirs, live, row } = await waiting();
    await pool.query(`UPDATE personal_run_enablements SET status = 'paused' WHERE owner_user_id = $1`, [scene.owner.id]);
    const paused = await apply(scene.owner, row.id, { expectedVersion: row.version });
    assert.equal(paused.status, 409);
    assert.equal(code(paused), 'ASSISTANT_PAUSED');
    assert.equal((await rowOf(row.id)).state, 'waiting', 'still waiting, not closed');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
    await pool.query(`UPDATE personal_run_enablements SET status = 'active' WHERE owner_user_id = $1`, [scene.owner.id]);
    expectStatus(await apply(scene.owner, row.id, { expectedVersion: row.version }), 200);
    assert.equal((await scene.taskRow(theirs.id)).status, 'done');
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [live.runId])).rows[0].status, 'completed', 'the source run was not revived');
  });

  test('AST-5.4: a revoked grant, a narrowed project or a lost right refuses Apply, and getting it back cannot revive the saved change', async () => {
    const { theirs, row } = await waiting();
    const restore = await assistantGrant('denied');
    try {
      const refused = await apply(scene.owner, row.id, { expectedVersion: row.version });
      assert.equal(refused.status, 403);
      assert.equal(code(refused), 'ASSISTANT_CHANGE_INVALIDATED');
    } finally { await restore(); }
    assert.equal((await rowOf(row.id)).state, 'refused');
    assert.equal((await apply(scene.owner, row.id)).status, 409, 'with the grant back, the old intent stays closed');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
  });

  test('AST-5.4 held: Apply loses to a Not now, an expiry, a Stop, a narrowed project and a revoked grant that commit while it waits; none leaves an effect', async () => {
    // Each rival commits inside a held lock that the Apply is queued behind; the Apply then repeats its checks and finds the loser's view.
    const cases: { name: string; hold: (id: string, runId: string) => Promise<Awaited<ReturnType<AssistantScene['holding']>>>;
      rival: (query: (statement: string, values?: unknown[]) => Promise<unknown>, id: string, runId: string) => Promise<unknown>; closed: string }[] = [
      { name: 'Not now', closed: 'not_now', hold: (id) => scene.holding(`SELECT id FROM assistant_changes WHERE id = $1 FOR UPDATE`, [id]),
        rival: (query, id) => query(`UPDATE assistant_changes SET state = 'not_now', wait_reason = NULL, decided_by = $2, decided_at = now(), version = version + 1 WHERE id = $1`, [id, scene.owner.id]) },
      { name: 'expiry', closed: 'expired', hold: (id) => scene.holding(`SELECT id FROM assistant_changes WHERE id = $1 FOR UPDATE`, [id]),
        rival: (query, id) => query(`UPDATE assistant_changes SET state = 'expired', wait_reason = NULL, version = version + 1 WHERE id = $1`, [id]) },
      { name: 'Stop', closed: 'refused', hold: (_id, runId) => scene.holding(`SELECT id FROM personal_runs WHERE id = $1 FOR UPDATE`, [runId]),
        rival: (query, _id, runId) => query(`UPDATE personal_runs SET stop_requested_at = now(), status = 'stopped' WHERE id = $1`, [runId]) },
      { name: 'a narrowed project (S6)', closed: 'refused', hold: async () => scene.holding(`SELECT connection_id FROM agent_connection_mcp_policies WHERE connection_id = $1 FOR UPDATE`, [await scene.assistantConnectionId()]),
        rival: (query) => query(`DELETE FROM agent_connection_mcp_projects WHERE connection_id = $1 AND project_id = $2`, [assistantConnectionOf(), scene.place.id]) },
      { name: 'a revoked grant', closed: 'refused', hold: async () => {
        const rows = (await pool.query(`SELECT id FROM project_grants WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId])).rows;
        assert.equal(rows.length, 1, 'the assistant holds one project grant');
        return scene.holding(`SELECT id FROM project_grants WHERE project_id = $1 AND agent_id = $2 FOR UPDATE`, [scene.place.id, scene.agentId]);
      }, rival: (query) => query(`UPDATE project_grants SET role = 'denied' WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId]) },
    ];
    const assistantConnection = await scene.assistantConnectionId();
    for (const entry of cases) {
      const { theirs, live, row } = await waiting(`Jonas held ${entry.name} ${randomUUID().slice(0, 4)}`);
      const held = await entry.hold(row.id, live.runId);
      let response: Awaited<ReturnType<typeof apply>>;
      try { response = await held.racing(() => apply(scene.owner, row.id, { expectedVersion: row.version }), (query) => entry.rival(query, row.id, live.runId)); }
      finally {
        if (entry.name === 'a narrowed project (S6)') await pool.query(`INSERT INTO agent_connection_mcp_projects (workspace_id, connection_id, project_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [scene.ws.id, assistantConnection, scene.place.id]);
        if (entry.name === 'a revoked grant') await pool.query(`UPDATE project_grants SET role = 'contributor' WHERE project_id = $1 AND agent_id = $2`, [scene.place.id, scene.agentId]);
      }
      assert.ok(response.status >= 400 && response.status < 500, `${entry.name}: the Apply loses (${response.status})`);
      assert.notEqual((await scene.taskRow(theirs.id)).status, 'done', `${entry.name}: no effect`);
      const closed = await rowOf(row.id);
      assert.equal(closed.state, entry.closed, entry.name);
      assert.equal(closed.receipt, null, `${entry.name}: no receipt`);
      assert.equal(closed.authority, null, `${entry.name}: no approval recorded`);
      // The winner's state is final: a later Apply cannot revive it.
      assert.equal((await apply(scene.owner, row.id)).status, 409);
    }
  });

  test('AST-5.7: the deferred-edit purpose belongs to one live-Wiki edit; no other waiting change can select it, a switched-off Wiki ends the deferral and turning it on cannot revive it', async () => {
    const { theirs, row } = await waiting('Jonas cannot be changed by a deferral');
    const stored = (await pool.query(`SELECT * FROM assistant_changes WHERE id = $1`, [row.id])).rows[0];
    const camel = { ...stored, id: stored.id, runId: stored.run_id, ownerUserId: stored.owner_user_id, workspaceId: stored.workspace_id, preparedCommand: stored.prepared_command } as never;
    const outcome = await reexecuteChange(db, camel, 'owner_deferred_change', null);
    assert.equal(outcome.ok, false);
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done', 'nothing was applied by a purpose it cannot select');
    assert.equal((await rowOf(row.id)).state, 'waiting');
    // A real deferral: the page is being typed in; then the Wiki is switched to Only read.
    const page = await scene.doc(scene.owner, 'Deferred notes');
    const stop = await scene.typing(scene.peer, page.id);
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Edited later' } })).message), /when aa-jonas finishes typing\.$/);
    await scene.complete(live.runId);
    await scene.save({ areas: { wiki: 'read' } });
    assert.equal((await changesOf(live.runId))[0]!.state, 'refused');
    await scene.save({ areas: { wiki: 'edit' } });
    await stop();
    await assistantChangeUseCases(db).sweep();
    assert.equal((await scene.docBody(page.id)).body, 'First text', 'switching it on again cannot revive the old edit');
    // A deferral that does settle is an ordinary change afterwards: its receipt keeps the source, the actual purpose and a conditional Undo.
    const later = await scene.doc(scene.owner, 'Settled notes');
    const typist = await scene.typing(scene.peer, later.id);
    const settled = await scene.liveRun();
    await settled.call('flux_update_doc', { docId: later.id, expectedVersion: later.version, changes: { body: 'Edited after Jonas' } });
    await scene.complete(settled.runId);
    await typist();
    await assistantChangeUseCases(db).sweep();
    assert.equal((await scene.docBody(later.id)).body, 'Edited after Jonas');
    const [done] = await changesOf(settled.runId);
    assert.deepEqual([done!.state, done!.authority, done!.receipt!.runId, done!.receipt!.preparedBy], ['applied_after_wait', 'owner_deferred_change', settled.runId, scene.agentId]);
    const undone = expectStatus(await run('POST', assistantRunChangesActionPath(settled.runId, 'undo'), scene.owner), 200) as AssistantRunUndone;
    assert.equal(undone.undone, 1);
    assert.equal((await scene.docBody(later.id)).body, 'First text');
  });

  test('AST-5.5: Apply just before the seventh day works and does not extend the deadline; at seven days the change is expired; a stale item stays closed', async () => {
    const { theirs, row } = await waiting();
    const before = await rowOf(row.id);
    const justBefore = assistantChangeUseCases(db, undefined, () => new Date(before.expires_at.getTime() - 60_000));
    await justBefore.apply(human_(scene.owner), row.id);
    assert.equal((await scene.taskRow(theirs.id)).status, 'done');
    const after = await rowOf(row.id);
    assert.equal(after.state, 'applied_after_wait');
    assert.equal(after.expires_at.getTime(), before.expires_at.getTime(), 'approval never renews the seven days');
    const second = await waiting('Jonas expires');
    const deadline = (await rowOf(second.row.id)).expires_at;
    assert.equal(deadline.getTime() - (await rowOf(second.row.id) as unknown as { created_at: Date }).created_at.getTime(), 7 * DAY, 'seven days from preparation');
    const atSeven = assistantChangeUseCases(db, undefined, () => deadline);
    await assert.rejects(atSeven.apply(human_(scene.owner), second.row.id), (error: Error & { code?: string }) => error.code === 'ASSISTANT_CHANGE_EXPIRED');
    assert.equal((await rowOf(second.row.id)).state, 'expired');
    assert.notEqual((await scene.taskRow(second.theirs.id)).status, 'done');
  });

  test('AST-5.4 (allowance): Apply all is one write-only allowance of the owner\'s current limit; the surplus stays waiting for the next Apply and nothing runs a model', async () => {
    await scene.save({ approvalMode: 'ask' });
    const live = await scene.liveRun();
    for (let i = 1; i <= 22; i += 1) assert.match(text((await live.call('flux_create_task', { task: { title: `Allowance task ${i}` } })).message), /^Waiting for /);
    await scene.complete(live.runId);
    const runsBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n);
    const first = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'apply'), scene.owner), 200) as { changes: { change: AssistantChange; message: string | null }[] };
    assert.equal(first.changes.filter((entry) => entry.change.state === 'applied_after_wait').length, 20);
    const surplus = first.changes.filter((entry) => entry.change.state === 'waiting');
    assert.equal(surplus.length, 2);
    assert.ok(surplus.every((entry) => /^Past 20 changes in one Apply\. Apply again for the rest$/.test(entry.message ?? '')));
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title LIKE 'Allowance task %'`)).rows[0].n), 20);
    const second = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'apply'), scene.owner), 200) as { changes: { change: AssistantChange }[] };
    assert.deepEqual(second.changes.map((entry) => entry.change.state), ['applied_after_wait', 'applied_after_wait']);
    const log = await changesOf(live.runId);
    assert.ok(log.every((item) => item.state === 'applied_after_wait' && item.authority === 'owner_approval' && item.decided_by === scene.owner.id));
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n), runsBefore, 'no new run, no model request');
    // An approved change keeps its source history and is an ordinary conditional Undo.
    const taken = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), scene.owner), 200) as AssistantRunUndone;
    assert.equal(taken.undone, 22);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title LIKE 'Allowance task %' AND creation_reverted_at IS NULL`)).rows[0].n), 0, 'every created task was taken back');
    // The owner's lower limit binds the allowance too.
    await scene.save({ approvalMode: 'ask', changesPerRun: 3 });
    const next = await scene.liveRun();
    for (let i = 1; i <= 5; i += 1) await next.call('flux_create_task', { task: { title: `Lower task ${i}` } });
    await scene.complete(next.runId);
    const lowered = expectStatus(await run('POST', assistantRunChangesActionPath(next.runId, 'apply'), scene.owner), 200) as { changes: { change: AssistantChange }[] };
    assert.deepEqual(lowered.changes.map((entry) => entry.change.state), ['applied_after_wait', 'applied_after_wait', 'applied_after_wait', 'waiting', 'waiting']);
  });

  test('AST-6.2: Undo of done-when, prerequisites, who a task waits for and a map\'s name; each is a new version, and an edit since says "Changed since. Open it"', async () => {
    const criteria = await scene.task(scene.owner, 'Probe calibration');
    const edited = await scene.task(scene.owner, 'Lamp wiring');
    const prerequisite = await scene.task(scene.owner, 'Order the probes');
    const dependent = await scene.task(scene.owner, 'Mount the probes');
    const blockedTask = await scene.task(scene.owner, 'Lens delivery');
    const unblock = await scene.task(scene.owner, 'Filter swap');
    const map = await scene.map(scene.owner, 'Sensor map');
    // A task a person blocked on Jonas; the assistant's later move to In progress clears who and why, and Undo puts both back.
    await scene.patchWork(scene.owner, unblock.id, unblock.version, { status: 'blocked', blocker: 'Filter on back order', waitingFor: { kind: 'human', id: scene.peer.id } });
    const unblockNow = await scene.taskRow(unblock.id);
    const live = await scene.liveRun();
    await live.call('flux_update_task', { workId: criteria.id, expectedVersion: criteria.version, changes: { criteria: ['Calibrated at two depths', 'Logged in the Wiki'] } });
    await live.call('flux_update_task', { workId: edited.id, expectedVersion: edited.version, changes: { criteria: ['Wired and tested'] } });
    await live.call('flux_update_task', { workId: dependent.id, expectedVersion: dependent.version, changes: { dependencyIds: [prerequisite.id] } });
    await live.call('flux_update_task', { workId: blockedTask.id, expectedVersion: blockedTask.version,
      changes: { status: 'blocked', blocker: 'Lens is late', waitingForUserId: scene.peer.id } });
    await live.call('flux_update_task', { workId: unblock.id, expectedVersion: unblockNow.version, changes: { status: 'in_progress' } });
    await live.call('flux_rename_map', { mapId: map.id, expectedVersion: map.version, title: 'Sensor rig map' });
    await scene.complete(live.runId);
    assert.deepEqual((await scene.taskRow(criteria.id)).criteria, ['Calibrated at two depths', 'Logged in the Wiki']);
    assert.deepEqual(await scene.dependencies(dependent.id), [prerequisite.id]);
    assert.deepEqual([(await scene.taskRow(blockedTask.id)).status, (await scene.taskRow(blockedTask.id)).waiting_for_user_id], ['blocked', scene.peer.id]);
    assert.deepEqual([(await scene.taskRow(unblock.id)).status, (await scene.taskRow(unblock.id)).waiting_for_user_id, (await scene.taskRow(unblock.id)).blocker], ['in_progress', null, null]);
    const listed = (expectStatus(await scene.owner.browser.request('GET', assistantRunChangesPath(live.runId)), 200) as { items: AssistantChange[] }).items;
    assert.equal(assistantMessageHeader(listed), 'Done: added done-when to 2 tasks, set prerequisites of 1 task, changed 2 tasks, renamed 1 map');
    assert.ok(listed.every((change) => change.undoable), 'every one of them can be taken back');
    assert.deepEqual([listed[0]!.before, listed[0]!.after], ['no done-when', '2 done-when']);
    assert.deepEqual([listed[2]!.before, listed[2]!.after], ['no prerequisites', '1 prerequisite']);
    // A person edits one task's done-when after the assistant: that item changed since; the others come back.
    await scene.patchWork(scene.peer, edited.id, (await scene.taskRow(edited.id)).version, { criteria: ['Wired, tested and signed off'] });
    const undone = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), scene.owner), 200) as AssistantRunUndone;
    assert.equal(undone.undone, 5);
    assert.deepEqual(undone.changedSince, [`#${edited.number}`]);
    assert.equal(undone.message, `Undid 5 changes. 1 changed since: #${edited.number}`);
    assert.deepEqual((await scene.taskRow(criteria.id)).criteria, [], 'done-when is back');
    assert.deepEqual((await scene.taskRow(edited.id)).criteria, ['Wired, tested and signed off'], 'the edit since is untouched');
    assert.deepEqual(await scene.dependencies(dependent.id), [], 'prerequisites are back');
    assert.deepEqual([(await scene.taskRow(blockedTask.id)).status, (await scene.taskRow(blockedTask.id)).waiting_for_user_id, (await scene.taskRow(blockedTask.id)).blocker], ['open', null, null]);
    assert.deepEqual([(await scene.taskRow(unblock.id)).status, (await scene.taskRow(unblock.id)).waiting_for_user_id, (await scene.taskRow(unblock.id)).blocker],
      ['blocked', scene.peer.id, 'Filter on back order'], 'leaving Blocked is undone with its reason and the person it waited for');
    assert.equal((await pool.query(`SELECT title FROM sketches WHERE id = $1`, [map.id])).rows[0].title, 'Sensor map');
    const log = await changesOf(live.runId);
    assert.deepEqual(log.map((item) => item.state), ['undone', 'applied', 'undone', 'undone', 'undone', 'undone']);
  });

  test('AST-6.2: anyone who may edit can undo the message; it is theirs and recorded; a viewer, a guest and a stranger cannot, and everyone who can read sees what was done', async () => {
    const page = await scene.doc(scene.owner, 'Wiring', 'Wire notes');
    const renamed = await scene.task(scene.owner, 'Probes');
    const live = await scene.liveRun();
    await live.call('flux_create_task', { task: { title: 'A fresh task' } });
    await live.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Wire notes, extended' } });
    await live.call('flux_update_task', { workId: renamed.id, expectedVersion: renamed.version, changes: { title: 'Calibrate the probes at two depths' } });
    await scene.complete(live.runId);
    const reason = (await pool.query(`SELECT reason FROM project_material_versions WHERE material_id = $1 AND version = $2`, [page.id, page.version + 1])).rows[0].reason as string;
    assert.match(reason, /^Asked by aa-ada: /, 'the Wiki version says whose request it was');
    // What was done is the run's message for everyone who can read the conversation.
    const ofThisRun = async (who: Person) => (await scene.listConversation(who)).filter((change) => change.runId === live.runId);
    for (const who of [scene.peer, scene.outsider, scene.admin, scene.viewer, scene.guest]) {
      const seen = await ofThisRun(who);
      assert.equal(seen.length, 3, 'three changes, nothing waiting');
      assert.ok(seen.every((change) => change.state === 'applied' && change.owner?.name === 'aa-ada' && change.line === null));
      assert.equal(assistantMessageHeader(seen), 'Done: added 1 task, edited 1 page, renamed 1 task');
    }
    assert.equal((await scene.stranger.browser.request('GET', conversationAssistantChangesPath(scene.thread.id))).status, 404);
    const undoable = (who: Person) => ofThisRun(who).then((items) => items.every((change) => change.undoable));
    assert.equal(await undoable(scene.viewer), false);
    assert.equal(await undoable(scene.guest), false);
    // Refused without a trace.
    for (const who of [scene.viewer, scene.guest]) {
      assert.equal((await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), who)).status, 403);
      assert.equal((await run('POST', assistantChangeActionPath((await changesOf(live.runId))[0]!.id, 'undo'), who)).status, 403);
    }
    for (const action of ['undo'] as const) assert.equal((await run('POST', assistantRunChangesActionPath(live.runId, action), scene.stranger)).status, 404);
    assert.deepEqual((await changesOf(live.runId)).map((item) => item.state), ['applied', 'applied', 'applied']);
    // Jonas may edit: his Undo is his own, through the same domain commands under his rights, and it is recorded.
    // Taking back the creation of a task is the creating assistant's owner's alone (#238): it is not offered to Jonas, and his message-wide Undo leaves it.
    const byJonas = await ofThisRun(scene.peer);
    assert.deepEqual(byJonas.map((change) => [change.operation, change.undoable]), [['work.create', false], ['doc.update', true], ['work.update', true]]);
    const task = (await changesOf(live.runId))[0]!;
    const refusedCreation = expectStatus(await run('POST', assistantChangeActionPath(task.id, 'undo'), scene.peer), 200) as { message: string; change: AssistantChange };
    assert.equal(refusedCreation.message, 'Only aa-ada can undo a task their assistant added');
    assert.equal(refusedCreation.change.state, 'applied');
    const undone = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), scene.peer), 200) as AssistantRunUndone;
    assert.equal(undone.undone, 2);
    assert.equal(undone.message, 'Undid 2 changes');
    assert.equal((await scene.docBody(page.id)).body, 'Wire notes');
    assert.equal((await scene.taskRow(renamed.id)).title, 'Probes');
    const undoReason = (await pool.query(`SELECT reason, author_id FROM project_material_versions WHERE material_id = $1 AND version = $2`, [page.id, page.version + 2])).rows[0] as { reason: string; author_id: string };
    assert.equal(undoReason.reason, 'Undo: aa-jonas undid aa-ada\'s assistant\'s change');
    assert.equal(undoReason.author_id, scene.peer.id, 'the restore is his write, not the owner\'s');
    const log = await changesOf(live.runId);
    assert.deepEqual(log.map((item) => item.state), ['applied', 'undone', 'undone']);
    assert.ok(log.slice(1).every((item) => item.decided_by === scene.peer.id && (item.receipt as { undone?: { by?: string } }).undone?.by === scene.peer.id));
    const seenByAda = await ofThisRun(scene.owner);
    assert.ok(seenByAda.slice(1).every((change) => change.line === 'Undone by aa-jonas' && change.decidedBy?.name === 'aa-jonas'));
    // Ada can still take back her own assistant's creation.
    const rest = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), scene.owner), 200) as AssistantRunUndone;
    assert.equal(rest.undone, 1);
  });

  test('AST-6.5 (background): a background run may change ten things; the eleventh waits, and Apply all is held to the same ten', async () => {
    const live = await scene.liveRun();
    await pool.query(`UPDATE personal_runs SET authority = 'owner_schedule', background_label = 'Morning summary' WHERE id = $1`, [live.runId]);
    for (let i = 1; i <= 10; i += 1) assert.ok(JSON.parse(text((await live.call('flux_create_task', { task: { title: `Background task ${i}` } })).message)).workId, `change ${i} applies`);
    assert.match(text((await live.call('flux_create_task', { task: { title: 'Background task 11' } })).message), /^Waiting for aa-ada's OK: add task Background task 11\.$/);
    assert.equal((await changesOf(live.runId)).at(-1)!.wait_reason, 'limit');
    await scene.complete(live.runId);
    const waitingRun = await scene.liveRun();
    await scene.save({ approvalMode: 'ask' });
    await pool.query(`UPDATE personal_runs SET authority = 'owner_reaction', background_label = 'Blocked-task watch' WHERE id = $1`, [waitingRun.runId]);
    for (let i = 1; i <= 12; i += 1) await waitingRun.call('flux_create_task', { task: { title: `Reaction task ${i}` } });
    await scene.complete(waitingRun.runId);
    const all = expectStatus(await run('POST', assistantRunChangesActionPath(waitingRun.runId, 'apply'), scene.owner), 200) as { changes: { change: AssistantChange }[] };
    assert.equal(all.changes.filter((entry) => entry.change.state === 'applied_after_wait').length, 10);
    assert.equal(all.changes.filter((entry) => entry.change.state === 'waiting').length, 2);
  });

  test('AST-6.8: the owner\'s own request goes before background runs; behind one it says what it waits for; others see only that her assistant is working', async () => {
    const owner = human_(scene.owner);
    const uow = personalRunWorkerUnitOfWork(db);
    // A background run (A8 and A9 start them) holds the lane: seeded with its stored authority and short name.
    const summary = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Write the morning summary' });
    await pool.query(`UPDATE personal_runs SET authority = 'owner_schedule', background_label = 'Morning summary', status = 'reading' WHERE id = $1`, [summary.run.id]);
    const mine = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Turn this into tasks' });
    assert.equal(mine.run.status, 'queued');
    assert.deepEqual(mine.run.behind, { runId: summary.run.id, authority: 'owner_schedule', label: 'Morning summary' });
    const read = expectStatus(await scene.owner.browser.request('GET', `/api/v1/assistant-runs/${mine.run.id}`), 200) as AssistantRun;
    assert.deepEqual(read.behind?.label, 'Morning summary');
    await assert.rejects(scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'A third' }), { code: 'PERSONAL_RUN_IN_FLIGHT' });
    // Everyone in the place sees only that it is working (names, no detail), and nothing of the runs themselves.
    for (const who of [scene.peer, scene.viewer, scene.guest, scene.admin]) {
      const activity = expectStatus(await who.browser.request('GET', conversationAssistantActivityPath(scene.thread.id)), 200) as AssistantActivity;
      assert.deepEqual(activity.working, [{ ownerId: scene.owner.id, ownerName: 'aa-ada' }]);
      assert.equal((await who.browser.request('GET', `/api/v1/assistant-runs/${mine.run.id}`)).status, 404);
      assert.equal((await who.browser.request('GET', `/api/v1/assistant-runs/${summary.run.id}`)).status, 404);
    }
    assert.equal((await scene.stranger.browser.request('GET', conversationAssistantActivityPath(scene.thread.id))).status, 404);
    // "Stop the summary" is Stop of the background run; the request starts next.
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${summary.run.id}/stop`), 200);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now() WHERE id = $1`, [summary.run.id]);
    assert.deepEqual(await uow.run((ports) => ports.runs.startableQueued(50)).then((ids) => ids.filter((id) => id === mine.run.id)), [mine.run.id]);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [mine.run.id]);
    // Both queued, the background one older: the owner's request is first, and the background run does not pass it.
    const older = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Background first in line' });
    await pool.query(`UPDATE personal_runs SET authority = 'owner_reaction', background_label = 'Blocked-task watch', created_at = created_at - interval '1 hour' WHERE id = $1`, [older.run.id]);
    const newer = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'My request' });
    assert.deepEqual(await uow.run((ports) => ports.runs.startableQueued(50)).then((ids) => ids.filter((id) => [older.run.id, newer.run.id].includes(id))), [newer.run.id]);
    assert.equal(await uow.run((ports) => ports.runs.laneBusy(scene.owner.id, older.run.id)), true, 'the background run waits for the request');
    assert.equal(await uow.run((ports) => ports.runs.laneBusy(scene.owner.id, newer.run.id)), false);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = ANY($1)`, [[older.run.id, newer.run.id]]);
  });

  test('AST-6.8: others hear that an assistant started and stopped working, by identifiers only, on the project stream', async () => {
    const peerStream = await StreamClient.connect(scene.peer.browser);
    const strangerStream = await StreamClient.connect(scene.stranger.browser);
    try {
      const started = await scene.runs.invoke(human_(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy up' });
      assert.equal(await scene.processor.process(started.run.id), 'completed');
      const events = await waitFor(async () => {
        const found = peerStream.events.filter((event) => event.kind === ASSISTANT_WORKING_EVENT && event.objectId === scene.place.id);
        return found.length >= 2 ? found : null;
      }, 'the working events');
      assert.ok(events.every((event) => event.objectType === 'project'));
      const stored = await pool.query(`SELECT e.data, array_agg(a.recipient) AS recipients FROM events e JOIN event_audience a ON a.event_id = e.id
        WHERE e.kind = $1 AND e.object_id = $2 AND e.id = ANY($3) GROUP BY e.seq, e.data ORDER BY e.seq`, [ASSISTANT_WORKING_EVENT, scene.place.id, events.map((event) => event.id)]);
      assert.equal(stored.rows.length, 2, 'one when it starts working, one when it stops');
      for (const item of stored.rows as { data: Record<string, unknown>; recipients: string[] }[]) {
        assert.deepEqual(Object.keys(item.data), ['conversationId'], 'identifiers only: no prompt, no run id, no status');
        assert.equal(item.data.conversationId, scene.thread.id);
        assert.ok(item.recipients.includes(`human:${scene.peer.id}`) && !item.recipients.includes(`human:${scene.stranger.id}`));
      }
      assert.ok(!JSON.stringify(stored.rows).includes('Tidy up'));
      assert.deepEqual(strangerStream.events.filter((event) => event.kind === ASSISTANT_WORKING_EVENT), [], 'someone outside the project hears nothing');
    } finally { await peerStream.close(); await strangerStream.close(); }
  });

  test('AST-5.4: switching the assistant off invalidates what it prepared; turning it on again cannot revive it', async () => {
    const { theirs, row } = await waiting('Jonas off and on');
    await scene.runs.remove(human_(scene.owner));
    const refused = await apply(scene.owner, row.id, { expectedVersion: row.version });
    assert.ok(refused.status === 403 || refused.status === 404 || refused.status === 409, `refused (${refused.status})`);
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
    await scene.runs.enable(human_(scene.owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: scene.agentId, connectionId: scene.connectionId, perRunCents: 50, dailyCapCents: 1_000 });
    const again = await apply(scene.owner, row.id, { expectedVersion: row.version });
    assert.ok(again.status >= 400, 'the old intent is not revived');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
  });
});
