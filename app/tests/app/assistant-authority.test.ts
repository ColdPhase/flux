import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assistantChangeActionPath, assistantChangeLine, assistantRunChangesActionPath, assistantRunChangesPath,
  conversationAssistantChangesPath, NEEDS_YOU_PATH, type AssistantChange,
  type AssistantRun, type AssistantRunUndone, type NeedsYouResponse,
} from '@flux/contracts';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { agentConnection } from './support/mcp-actions.js';
import { expectStatus, grant, removeFromSpace, type Person } from './support/people.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { StreamClient } from './support/stream.js';
import { assistantScene, changesOf, human, text, type AssistantScene } from './support/assistant-scene.js';

// F-027 A3/A4 (#403, #404), F-036 AG-3 (#855): who may decide a waiting change (only its owner, in their own session; never an agent or a
// run token) and who may undo what was done; what an Approve repeats and what it may not do (held races against Skip, Stop and the owner
// losing the project); Undo of done-when, prerequisites, waiting-for and a map's name; Undo by anyone who may edit; the owner's lane with a
// background run; and the working line everyone sees. A fake clock and fake CLI stand in for every vendor, and the one run that is worked is pi in the
// agent runtime (#1441, RT-1) on a scripted model gateway; no model, CLI or account is used.

const human_ = human;
let scene: AssistantScene;
let pi: PiRuntime;
const run = (method: string, path: string, who: Person, body: unknown = {}) => who.browser.request(method, path, { body });
const apply = (who: Person, id: string, body: unknown = {}) => run('POST', assistantChangeActionPath(id, 'apply'), who, body);
const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const rowOf = async (id: string) => (await pool.query(`SELECT * FROM assistant_changes WHERE id = $1`, [id])).rows[0] as Awaited<ReturnType<typeof changesOf>>[number] & { expires_at: Date };
/** The owner removed from the project for the length of one check: the assistant has exactly the owner's rights (F-036 AG-3). */
async function keepOwnerOut() {
  await removeFromSpace(scene.lead, scene.place.id, scene.owner);
  return async () => { await grant(scene.lead, scene.place.id, scene.owner, 'manager'); };
}

describe('the assistant\'s waiting changes and Undo: who may, and what may not happen (F-027 A3/A4, #403/#404)', () => {
  before(async () => { pi = await startPiRuntime(); scene = await assistantScene('aa', { pi }); });
  after(async () => { await pi.close(); });
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

  test('AG-3: only the owner reads, approves, edits or skips a waiting change; another member, an admin, a viewer, a guest, a stranger, an agent and a run token are refused', async () => {
    const { theirs, live, row } = await waiting();
    const outside = [scene.peer, scene.outsider, scene.admin, scene.viewer, scene.guest, scene.stranger];
    for (const who of outside) {
      for (const action of ['apply', 'skip', 'undo'] as const)
        assert.equal((await run('POST', assistantChangeActionPath(row.id, action), who)).status, 404, `${action} by someone else`);
      assert.equal((await run('POST', assistantChangeActionPath(row.id, 'edit'), who, { expectedVersion: row.version, title: 'Theirs' })).status, 404, 'edit by someone else');
      for (const action of ['apply', 'skip', 'undo'] as const)
        assert.equal((await run('POST', assistantRunChangesActionPath(live.runId, action), who)).status, 404, `${action} of the run by someone else`);
      assert.equal((await who.browser.request('GET', assistantRunChangesPath(live.runId))).status, 404);
      assert.ok(!(expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.some((item) => item.key === `assistant:${live.runId}`));
      const listed = await who.browser.request('GET', conversationAssistantChangesPath(scene.thread.id));
      if (who === scene.stranger) assert.equal(listed.status, 404, 'not even a conversation of a project they cannot read');
      else assert.ok(!(expectStatus(listed, 200) as { items: AssistantChange[] }).items.some((change) => change.id === row.id), 'a waiting change is never in another person\'s list');
    }
    // An agent's bearer and the run's own token are not a session: neither can decide anything, not even its own change (AG-3).
    const codexAgent = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada Codex', owner: 'self' } }), 201) as { id: string }).id;
    const codex = await agentConnection(pool, scene.owner.browser, codexAgent, [scene.place.id]);
    for (const bearer of [codex.accessToken, live.token]) {
      for (const path of [assistantChangeActionPath(row.id, 'apply'), assistantChangeActionPath(row.id, 'skip'), assistantChangeActionPath(row.id, 'edit'),
        assistantRunChangesActionPath(live.runId, 'apply'), `/api/v1/agent-connections/${codex.connectionId}`]) {
        const response = await fetch(`${apiUrl}${path}`, { method: path.includes('agent-connections') ? 'PATCH' : 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(path.includes('agent-connections') ? { mayDo: 'act' } : { expectedVersion: row.version, title: 'Agent edit' }) });
        assert.ok(response.status === 401 || response.status === 403, `a bearer is refused at ${path} (${response.status})`);
      }
    }
    // And no tool of any agent approves, skips, edits or accepts: there is none to call.
    for (const tools of [live.tools]) assert.ok(!tools.some((name) => /approve|apply|skip|accept|decide|grant|may_do|setting/.test(name)), 'no deciding tool');
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

  test('AST-5.4: an agent the owner deleted cannot be Applied; nothing is changed and nothing is revived', async () => {
    const { theirs, live, row } = await waiting();
    const current = (await scene.settings()).agentId;
    await pool.query(`UPDATE agents SET revoked_at = now() WHERE id = $1`, [current]);
    try {
      const gone = await apply(scene.owner, row.id, { expectedVersion: row.version });
      assert.notEqual(gone.status, 200);
      assert.equal(code(gone), 'ASSISTANT_CHANGE_INVALIDATED');
      assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
    } finally {
      await pool.query(`UPDATE agents SET revoked_at = NULL WHERE id = $1`, [current]);
    }
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [live.runId])).rows[0].status, 'completed', 'the source run was not revived');
  });

  test('AG-3: when the owner loses the project, Approve is refused, and getting it back cannot revive the saved change', async () => {
    const { theirs, row } = await waiting();
    const restore = await keepOwnerOut();
    try {
      const refused = await apply(scene.owner, row.id, { expectedVersion: row.version });
      assert.equal(refused.status, 403);
      assert.equal(code(refused), 'ASSISTANT_CHANGE_INVALIDATED');
    } finally { await restore(); }
    assert.equal((await rowOf(row.id)).state, 'refused');
    assert.equal((await apply(scene.owner, row.id)).status, 409, 'with the grant back, the old intent stays closed');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
  });

  test('AST-5.4 held: Approve loses to a Skip, a Stop and the owner removed from the project that commit while it waits; none leaves an effect', async () => {
    // Each rival commits inside a held lock that the Apply is queued behind; the Apply then repeats its checks and finds the loser's view.
    const cases: { name: string; hold: (id: string, runId: string) => Promise<Awaited<ReturnType<AssistantScene['holding']>>>;
      rival: (query: (statement: string, values?: unknown[]) => Promise<unknown>, id: string, runId: string) => Promise<unknown>; closed: string }[] = [
      { name: 'Skip', closed: 'skipped', hold: (id) => scene.holding(`SELECT id FROM assistant_changes WHERE id = $1 FOR UPDATE`, [id]),
        rival: (query, id) => query(`UPDATE assistant_changes SET state = 'skipped', wait_reason = NULL, decided_by = $2, decided_at = now(), version = version + 1 WHERE id = $1`, [id, scene.owner.id]) },
      { name: 'Stop', closed: 'refused', hold: (_id, runId) => scene.holding(`SELECT id FROM personal_runs WHERE id = $1 FOR UPDATE`, [runId]),
        rival: (query, _id, runId) => query(`UPDATE personal_runs SET stop_requested_at = now(), status = 'stopped' WHERE id = $1`, [runId]) },
      // The owner removed: the project row a grant change takes first is held, and the removal commits before the Approve decides.
      { name: 'the owner removed', closed: 'refused', hold: () => scene.holding(`SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE`, [scene.place.id]),
        rival: (query) => query(`DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2`, [scene.place.id, scene.owner.id]) },
    ];
    for (const entry of cases) {
      const { theirs, live, row } = await waiting(`Jonas held ${entry.name} ${randomUUID().slice(0, 4)}`);
      const held = await entry.hold(row.id, live.runId);
      let response: Awaited<ReturnType<typeof apply>>;
      try { response = await held.racing(() => apply(scene.owner, row.id, { expectedVersion: row.version }), (query) => entry.rival(query, row.id, live.runId)); }
      finally {
        if (entry.name === 'the owner removed') await grant(scene.lead, scene.place.id, scene.owner, 'manager');
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

  test('#843: Apply all applies every waiting change of the run in one tap, with no change limit; nothing runs a model', async () => {
    await scene.setMayDo('ask');
    const live = await scene.liveRun();
    for (let i = 1; i <= 22; i += 1) assert.match(text((await live.call('flux_create_task', { task: { title: `Allowance task ${i}` } })).message), /^Waiting for /);
    await scene.complete(live.runId);
    const runsBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n);
    const all = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'apply'), scene.owner), 200) as { changes: { change: AssistantChange; message: string | null }[] };
    assert.equal(all.changes.filter((entry) => entry.change.state === 'applied_after_wait').length, 22, 'all twenty-two, in one Apply');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title LIKE 'Allowance task %'`)).rows[0].n), 22);
    const log = await changesOf(live.runId);
    assert.ok(log.every((item) => item.state === 'applied_after_wait' && item.authority === 'owner_approval' && item.decided_by === scene.owner.id));
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs`)).rows[0].n), runsBefore, 'no new run, no model request');
    // An approved change keeps its source history and is an ordinary conditional Undo.
    const taken = expectStatus(await run('POST', assistantRunChangesActionPath(live.runId, 'undo'), scene.owner), 200) as AssistantRunUndone;
    assert.equal(taken.undone, 22);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title LIKE 'Allowance task %' AND creation_reverted_at IS NULL`)).rows[0].n), 0, 'every created task was taken back');
  });

  test('AST-6.2: Undo of done-when, prerequisites, who a task waits for and a map\'s name; each is a new version, and an edit since says "Changed since. Open it"', async () => {
    const criteria = await scene.task(scene.owner, 'Probe calibration');
    const edited = await scene.task(scene.owner, 'Lamp wiring');
    const prerequisite = await scene.task(scene.owner, 'Order the probes');
    const dependent = await scene.task(scene.owner, 'Mount the probes');
    const blockedTask = await scene.task(scene.owner, 'Lens delivery');
    const unblock = await scene.task(scene.owner, 'Filter swap');
    const map = await scene.map(scene.owner, 'Sensor map');
    // A task a person blocked on Jonas; the assistant's later move to Doing clears who and why, and Undo puts both back.
    await scene.patchWork(scene.owner, unblock.id, unblock.version, { status: 'blocked', blocker: 'Filter on back order', waitingFor: { kind: 'human', id: scene.peer.id } });
    const unblockNow = await scene.taskRow(unblock.id);
    const live = await scene.liveRun();
    await live.call('flux_update_task', { workId: criteria.id, expectedVersion: criteria.version, changes: { criteria: ['Calibrated at two depths', 'Logged in the Wiki'] } });
    await live.call('flux_update_task', { workId: edited.id, expectedVersion: edited.version, changes: { criteria: ['Wired and tested'] } });
    await live.call('flux_update_task', { workId: dependent.id, expectedVersion: dependent.version, changes: { dependencyIds: [prerequisite.id] } });
    await live.call('flux_update_task', { workId: blockedTask.id, expectedVersion: blockedTask.version,
      changes: { status: 'blocked', blocker: 'Lens is late', waitingFor: scene.peer.id } });
    await live.call('flux_update_task', { workId: unblock.id, expectedVersion: unblockNow.version, changes: { status: 'in_progress' } });
    await live.call('flux_rename_map', { mapId: map.id, expectedVersion: map.version, title: 'Sensor rig map' });
    await scene.complete(live.runId);
    // Making a task wait for Jonas would tell him: it waits for the owner's OK (#1089), and the OK makes it, as the run's own change.
    const waiting = (await changesOf(live.runId)).filter((row) => row.state === 'waiting');
    assert.deepEqual(waiting.map((row) => [row.operation, row.wait_reason]), [['work.update', 'tells']]);
    expectStatus(await run('POST', assistantChangeActionPath(waiting[0]!.id, 'apply'), scene.owner), 200);
    assert.deepEqual((await scene.taskRow(criteria.id)).criteria, ['Calibrated at two depths', 'Logged in the Wiki']);
    assert.deepEqual(await scene.dependencies(dependent.id), [prerequisite.id]);
    assert.deepEqual([(await scene.taskRow(blockedTask.id)).status, (await scene.taskRow(blockedTask.id)).waiting_for_user_id], ['blocked', scene.peer.id]);
    assert.deepEqual([(await scene.taskRow(unblock.id)).status, (await scene.taskRow(unblock.id)).waiting_for_user_id, (await scene.taskRow(unblock.id)).blocker], ['in_progress', null, null]);
    const listed = (expectStatus(await scene.owner.browser.request('GET', assistantRunChangesPath(live.runId)), 200) as { items: AssistantChange[] }).items;
    assert.ok(assistantChangeLine(listed).includes(`moved #${unblock.number} to Doing`), 'the change line names the status move');
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

  test('AST-6.2: anyone who may edit can undo the message; it is theirs and recorded; a stranger cannot, and everyone who can read sees what was done', async () => {
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
      assert.equal(assistantChangeLine(seen), `Added task A fresh task · updated the Wiki page Wiring · renamed task #${renamed.number} Probes`);
    }
    assert.equal((await scene.stranger.browser.request('GET', conversationAssistantChangesPath(scene.thread.id))).status, 404);
    // Refused without a trace.
    for (const action of ['undo'] as const) assert.equal((await run('POST', assistantRunChangesActionPath(live.runId, action), scene.stranger)).status, 404);
    assert.deepEqual((await changesOf(live.runId)).map((item) => item.state), ['applied', 'applied', 'applied']);
    // Jonas may edit: his Undo is his own, through the same domain commands under his rights, and it is recorded.
    // Taking back the creation of a task is the creating assistant's owner's alone (#238): it is not offered to Jonas, and his message-wide Undo leaves it.
    const byJonas = await ofThisRun(scene.peer);
    assert.deepEqual(byJonas.map((change) => [change.operation, change.undoable]), [['work.create', false], ['doc.update', true], ['work.update', true]]);
    const task = (await changesOf(live.runId))[0]!;
    const refusedCreation = expectStatus(await run('POST', assistantChangeActionPath(task.id, 'undo'), scene.peer), 200) as { message: string; change: AssistantChange };
    assert.equal(refusedCreation.message, 'Only aa-ada can undo a task their agent added');
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

  test('#843 (background): a scheduled run has no change limit either; its twelfth change applies like its first', async () => {
    const live = await scene.liveRun();
    await pool.query(`UPDATE personal_runs SET authority = 'owner_schedule', background_label = 'Daily check' WHERE id = $1`, [live.runId]);
    for (let i = 1; i <= 12; i += 1) assert.ok(JSON.parse(text((await live.call('flux_create_task', { task: { title: `Background task ${i}` } })).message)).workId, `change ${i} applies`);
    assert.ok((await changesOf(live.runId)).every((item) => item.state === 'applied' && item.wait_reason === null));
    await scene.complete(live.runId);
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
    // #843: no Flux limit of two; a third request waits its turn as well (only a runaway client meets the safety bound).
    const third = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'A third' });
    assert.equal(third.run.status, 'queued');
    await scene.runs.stop(owner, third.run.id);
    // Nobody else learns of the runs: not by name, not at all (#842: `/ai` is private).
    for (const who of [scene.peer, scene.viewer, scene.guest, scene.admin]) {
      assert.equal((await who.browser.request('GET', `/api/v1/assistant-runs/${mine.run.id}`)).status, 404);
      assert.equal((await who.browser.request('GET', `/api/v1/assistant-runs/${summary.run.id}`)).status, 404);
    }
    // "Stop the summary" is Stop of the background run; the request starts next.
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${summary.run.id}/stop`), 200);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now() WHERE id = $1`, [summary.run.id]);
    assert.deepEqual(await uow.run((ports) => ports.runs.startableQueued(50)).then((ids) => ids.filter((id) => id === mine.run.id)), [mine.run.id]);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [mine.run.id]);
    // Both queued, the background one older: the owner's request is first, and the background run does not pass it.
    const older = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Background first in line' });
    await pool.query(`UPDATE personal_runs SET authority = 'owner_schedule', background_label = 'Blocked-task watch', created_at = created_at - interval '1 hour' WHERE id = $1`, [older.run.id]);
    const newer = await scene.runs.invoke(owner, scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'My request' });
    assert.deepEqual(await uow.run((ports) => ports.runs.startableQueued(50)).then((ids) => ids.filter((id) => [older.run.id, newer.run.id].includes(id))), [newer.run.id]);
    assert.equal(await uow.run((ports) => ports.runs.laneBusy(scene.owner.id, older.run.id)), true, 'the background run waits for the request');
    assert.equal(await uow.run((ports) => ports.runs.laneBusy(scene.owner.id, newer.run.id)), false);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = ANY($1)`, [[older.run.id, newer.run.id]]);
  });

  test('AST-6.8: the run of `/ai` is private: the others hear nothing on the project stream, not even that it worked', async () => {
    const peerStream = await StreamClient.connect(scene.peer.browser);
    try {
      const started = await scene.runs.invoke(human_(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy up' });
      pi.gateway.script([{ text: 'Nothing to tidy up.' }]);
      assert.equal(await scene.processor!.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(peerStream.events.filter((event) => event.kind.startsWith('project.assistant_')), []);
      const stored = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind LIKE 'project.assistant_%' AND object_id = $1`, [scene.place.id]);
      assert.equal(stored.rows[0].n, 0, 'no event about the run was written for the space');
    } finally { await peerStream.close(); }
  });

  test('AST-5.4: switching the assistant off invalidates what it prepared; turning it on again cannot revive it', async () => {
    const { theirs, row } = await waiting('Jonas off and on');
    await scene.runs.remove(human_(scene.owner));
    const refused = await apply(scene.owner, row.id, { expectedVersion: row.version });
    assert.ok(refused.status === 403 || refused.status === 404 || refused.status === 409, `refused (${refused.status})`);
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
    const fresh = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    await scene.runs.enable(human_(scene.owner), { agentId: fresh, connection: scene.connectionId, model: 'claude-sonnet-5' });
    const again = await apply(scene.owner, row.id, { expectedVersion: row.version });
    assert.ok(again.status >= 400, 'the old intent is not revived');
    assert.notEqual((await scene.taskRow(theirs.id)).status, 'done');
  });
});
