import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  agentConnectionPath, assistantChangeActionPath, assistantChangeLine, ASSISTANT_RUN_EFFECT_TOOLS, assistantRunChangesActionPath, docPath, NEEDS_YOU_PATH,
  type AssistantRunUndone, type Conversation, type NeedsYouResponse,
} from '@flux/contracts';
import { pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { toolValue } from './support/mcp.js';
import { agentConnection } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { assistantScene, changesOf, human, result, text, type AssistantScene } from './support/assistant-scene.js';

// F-036 AG-3 and AG-7 (#855): an agent's rights are exactly its owner's, and its "What it may do" (Only read, Do it and tell me, Ask me
// first) decides what happens within them. Deleting and other people's things always wait; only the owner decides, in their own session;
// Undo sits on the agent's message and restores the earlier versions; the Inbox holds one item per run. Run changes go through the real
// `/mcp` route with the run's own token, and every state is read back from the store. Fake engines stand in for every vendor.

let scene: AssistantScene;
const decide = (who: Person, id: string, action: 'apply' | 'skip' | 'edit', body: unknown = {}) => who.browser.request('POST', assistantChangeActionPath(id, action), { body });
const undoRun = async (who: Person, runId: string) => expectStatus(await who.browser.request('POST', assistantRunChangesActionPath(runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
const ownItems = async (who: Person = scene.owner) => (expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.filter((item) => item.key.startsWith('assistant:'));
const titled = async (title: string) => (await pool.query(`SELECT id, owner_user_id FROM project_work_items WHERE title = $1 AND project_id = $2`, [title, scene.place.id])).rows as { id: string; owner_user_id: string | null }[];
const thought = async (who: Person, mapId: string, value: string) => {
  const made = expectStatus(await who.browser.request('POST', `/api/v1/sketches/${mapId}/thoughts`, { body: { text: value, x: 0, y: 0 } }), 201) as { thought?: { id: string; version: number }; id?: string; version?: number };
  return { id: (made.thought?.id ?? made.id)!, version: (made.thought?.version ?? made.version)! };
};
const thoughtExists = async (id: string) => (await pool.query(`SELECT count(*)::int AS n FROM sketch_thoughts WHERE id = $1`, [id])).rows[0].n === 1;
const refusal = (message: Parameters<typeof text>[0]) => (JSON.parse(text(message)) as { code?: string }).code;
/** The owner kept out of the project for the length of one check: a keep-out is the one thing that lowers a workspace owner. */
async function keptOut(work: () => Promise<void>) {
  await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'denied', $4) ON CONFLICT (project_id, user_id) WHERE (user_id IS NOT NULL) DO UPDATE SET role = 'denied'`,
    [randomUUID(), scene.ws.id, scene.place.id, scene.owner.id]);
  try { await work(); }
  finally { await pool.query(`DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2`, [scene.place.id, scene.owner.id]); }
}

describe('What it may do, approvals, Undo and the Inbox (F-036 AG-3, AG-7, #855)', () => {
  before(async () => { scene = await assistantScene('wd'); });
  beforeEach(async () => { await scene.reset(); });

  test('the default is Do it and tell me: new things and what is yours are made at once, and each is on the change log', async () => {
    assert.equal((await scene.settings()).mayDo, 'act');
    const mine = await scene.task(scene.owner, 'Order spare probes');
    const live = await scene.liveRun();
    assert.ok(JSON.parse(text((await live.call('flux_create_task', { task: { title: 'Check the wiring' } })).message)).workId);
    assert.ok(JSON.parse(text((await live.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Order four probes' } })).message)).workId);
    assert.deepEqual((await changesOf(live.runId)).map((row) => [row.state, row.wait_reason, row.authority]), [['applied', null, 'owner_request'], ['applied', null, 'owner_request']]);
    assert.equal((await scene.taskRow(mine.id)).title, 'Order four probes');
  });

  test('Ask me first: every change waits, nothing is applied, and Approve makes exactly what was asked', async () => {
    const mine = await scene.task(scene.owner, 'Label the cables');
    await scene.setMayDo('ask');
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_create_task', { task: { title: 'Ask first task' } })).message), /^Waiting for /);
    assert.match(text((await live.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Label both cables' } })).message), /^Waiting for /);
    await scene.complete(live.runId);
    const [create, update] = await changesOf(live.runId);
    assert.deepEqual([create!.wait_reason, update!.wait_reason], ['ask', 'ask']);
    assert.equal((await titled('Ask first task')).length, 0);
    assert.equal((await scene.taskRow(mine.id)).title, 'Label the cables');
    const listed = await scene.listConversation(scene.owner);
    assert.equal(listed.find((change) => change.id === create!.id)?.line, 'Waits for your OK: you asked it to check with you first.');
    expectStatus(await decide(scene.owner, create!.id, 'apply', { expectedVersion: create!.version }), 200);
    expectStatus(await decide(scene.owner, update!.id, 'apply', { expectedVersion: update!.version }), 200);
    assert.equal((await titled('Ask first task')).length, 1);
    assert.equal((await scene.taskRow(mine.id)).title, 'Label both cables');
    const [made] = await changesOf(live.runId);
    assert.deepEqual([made!.state, made!.authority, made!.decided_by], ['applied_after_wait', 'owner_approval', scene.owner.id]);
  });

  test('Only read: the run has no change tool, a forced call changes nothing, and setting it stops a working run at its next change', async () => {
    await scene.setMayDo('read');
    const reading = await scene.liveRun();
    assert.ok(reading.tools.includes('flux_get_conversation'));
    assert.deepEqual(reading.tools.filter((name) => (ASSISTANT_RUN_EFFECT_TOOLS as readonly string[]).includes(name)), [], 'no change tool is offered');
    await reading.call('flux_create_task', { task: { title: 'Forced by a read-only run' } });
    assert.equal((await titled('Forced by a read-only run')).length, 0);
    await scene.complete(reading.runId);

    await scene.setMayDo('act');
    const working = await scene.liveRun();
    await scene.setMayDo('read');
    const refused = await working.call('flux_create_task', { task: { title: 'Made after Only read' } });
    assert.equal(result(refused.message)?.isError, true);
    assert.match(text(refused.message), /only reads?/i);
    assert.equal((await titled('Made after Only read')).length, 0);
  });

  test('deleting always waits, in both modes that change anything; [Delete] removes it and [Keep] leaves it', async () => {
    const sketch = await scene.map(scene.owner);
    for (const mode of ['act', 'ask'] as const) {
      await scene.setMayDo(mode);
      const stays = await thought(scene.owner, sketch.id, `Stays in ${mode}`);
      const goes = await thought(scene.owner, sketch.id, `Goes in ${mode}`);
      const live = await scene.liveRun();
      for (const item of [stays, goes])
        assert.match(text((await live.call('flux_remove_thought', { mapId: sketch.id, thoughtId: item.id, expectedVersion: item.version })).message), /^Waiting for /, mode);
      await scene.complete(live.runId);
      const rows = await changesOf(live.runId);
      assert.deepEqual(rows.map((row) => [row.state, row.wait_reason]), [['waiting', 'removal'], ['waiting', 'removal']], mode);
      assert.ok(await thoughtExists(stays.id) && await thoughtExists(goes.id), 'nothing is deleted before the OK');
      const line = (await scene.listConversation(scene.owner)).find((change) => change.id === rows[0]!.id)?.line;
      assert.equal(line, 'Deleting always waits for your OK.');
      const keep = rows.find((row) => row.object_id === stays.id)!;
      const remove = rows.find((row) => row.object_id === goes.id)!;
      assert.equal((expectStatus(await decide(scene.owner, keep.id, 'skip', { expectedVersion: keep.version }), 200) as { change: { state: string; line: string } }).change.line, 'Kept');
      expectStatus(await decide(scene.owner, remove.id, 'apply', { expectedVersion: remove.version }), 200);
      assert.equal(await thoughtExists(stays.id), true);
      assert.equal(await thoughtExists(goes.id), false);
    }
  });

  test('other people\'s things wait; what you or any of your agents made is yours, until someone else edits it', async () => {
    const theirs = await scene.task(scene.peer, 'Jonas calibrates');
    const otherAgent = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada Codex', owner: 'self' } }), 201) as { id: string }).id;
    const byMyAgent = await scene.task(scene.owner, 'Made by my other agent');
    await pool.query(`UPDATE project_work_items SET created_by_kind = 'agent', created_by_id = $2 WHERE id = $1`, [byMyAgent.id, otherAgent]);
    const page = await scene.doc(scene.owner, 'Shared notes');
    const edited = await scene.doc(scene.owner, 'Edited by Jonas');
    expectStatus(await scene.peer.browser.request('PATCH', docPath(edited.id), { body: { body: 'Jonas wrote this', state: 'published' }, headers: { 'if-match': `"${edited.version}"` } }), 200);
    const editedNow = await scene.docBody(edited.id);
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Calibrate today' } })).message), /^Waiting for /);
    assert.ok(JSON.parse(text((await live.call('flux_update_task', { workId: byMyAgent.id, expectedVersion: byMyAgent.version, changes: { title: 'Still mine' } })).message)).workId);
    assert.ok(!text((await live.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'New notes' } })).message).startsWith('Waiting for'));
    assert.match(text((await live.call('flux_update_doc', { docId: edited.id, expectedVersion: editedNow.current_version, changes: { body: 'Overwrites Jonas' } })).message), /^Waiting for /);
    assert.deepEqual((await changesOf(live.runId)).map((row) => [row.state, row.wait_reason]), [['waiting', 'others'], ['applied', null], ['applied', null], ['waiting', 'others']]);
    assert.equal((await scene.taskRow(theirs.id)).title, 'Jonas calibrates');
    assert.equal((await scene.docBody(edited.id)).body, 'Jonas wrote this');
  });

  test('a task for another person is a proposal: Approve, Edit and Skip; a task for its owner is made at once', async () => {
    const live = await scene.liveRun();
    assert.ok(JSON.parse(text((await live.call('flux_create_task', { task: { title: 'For Ada herself', ownerUserId: scene.owner.id } })).message)).workId);
    for (const title of ['Order sensors', 'Skip me'])
      assert.match(text((await live.call('flux_create_task', { task: { title, ownerUserId: scene.peer.id } })).message), /^Waiting for /);
    await scene.complete(live.runId);
    const [, order, skip] = await changesOf(live.runId);
    assert.deepEqual([order!.state, order!.wait_reason], ['waiting', 'others']);
    assert.equal((await titled('Order sensors')).length, 0, 'nothing assigned before the OK');
    const seen = (await scene.listConversation(scene.owner)).find((change) => change.id === order!.id)!;
    assert.deepEqual([seen.forPerson?.id, seen.line], [scene.peer.id, 'Tasks for other people wait for your OK.']);
    // Edit changes what will be made; another person, or a change that is no new task, cannot be edited.
    const edited = expectStatus(await decide(scene.owner, order!.id, 'edit', { expectedVersion: order!.version, title: 'Order 30 sensors' }), 200) as { change: { objectTitle: string; version: number } };
    assert.equal(edited.change.objectTitle, 'Order 30 sensors');
    assert.equal((await decide(scene.peer, order!.id, 'edit', { expectedVersion: edited.change.version, title: 'Jonas edits it' })).status, 404);
    expectStatus(await decide(scene.owner, order!.id, 'apply', { expectedVersion: edited.change.version }), 200);
    const [made] = await titled('Order 30 sensors');
    assert.equal(made?.owner_user_id, scene.peer.id, 'it is Jonas\'s task');
    expectStatus(await decide(scene.owner, skip!.id, 'skip', { expectedVersion: skip!.version }), 200);
    assert.equal((await titled('Skip me')).length, 0);
    assert.equal((await decide(scene.owner, skip!.id, 'apply')).status, 409, 'a skipped change cannot come back');
  });

  test('Inbox: one item per run with its count and Approve all; a run with nothing waiting and a run\'s report add none', async () => {
    const of = async (...runs: string[]) => (await ownItems()).filter((item) => runs.some((run) => item.key === `assistant:${run}`));
    const quiet = await scene.liveRun();
    await quiet.call('flux_create_task', { task: { title: 'Made at once' } });
    await scene.complete(quiet.runId);
    assert.deepEqual(await of(quiet.runId), [], 'what was only made and reported does not reach the Inbox');

    const live = await scene.liveRun();
    for (const title of ['One for Jonas', 'Two for Jonas', 'Three for Jonas'])
      await live.call('flux_create_task', { task: { title, ownerUserId: scene.peer.id } });
    await scene.complete(live.runId);
    const second = await scene.liveRun();
    await second.call('flux_create_task', { task: { title: 'From the next run', ownerUserId: scene.peer.id } });
    await scene.complete(second.runId);

    const items = await of(live.runId, second.runId);
    assert.deepEqual(items.map((item) => item.key).sort(), [`assistant:${live.runId}`, `assistant:${second.runId}`].sort(), 'one item per run, whatever it holds');
    const first = items.find((item) => item.key === `assistant:${live.runId}`)!;
    assert.equal(first.title, '3 things wait for you');
    assert.equal(first.assistantChanges?.agentName, 'Assistant');
    assert.equal(first.assistantChanges?.changes.length, 3);
    assert.ok(!(await ownItems(scene.peer)).some((item) => item.key === `assistant:${live.runId}`), 'the Inbox item is its owner\'s, even for a task meant for Jonas');

    // Approve all decides the run: all three, in one tap, and its item goes.
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(live.runId, 'apply'), { body: {} }), 200);
    assert.deepEqual((await changesOf(live.runId)).map((row) => row.state), ['applied_after_wait', 'applied_after_wait', 'applied_after_wait']);
    assert.deepEqual((await of(live.runId, second.runId)).map((item) => item.key), [`assistant:${second.runId}`]);
    // Nothing waiting ever expires: an old run still waits (AG-7).
    await pool.query(`UPDATE assistant_changes SET created_at = now() - interval '90 days' WHERE run_id = $1`, [second.runId]);
    assert.deepEqual((await of(second.runId)).map((item) => item.key), [`assistant:${second.runId}`]);
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(second.runId, 'skip'), { body: {} }), 200);
    assert.deepEqual(await of(second.runId), []);
  });

  test('Undo sits on the message: it restores the earlier versions, as new versions, and the line says who undid it', async () => {
    const page = await scene.doc(scene.owner, 'Calibration', 'Measured at noon');
    const job = await scene.task(scene.owner, 'Calibrate the probes');
    const live = await scene.liveRun();
    await live.call('flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Measured at noon and at night' } });
    const second = await scene.docBody(page.id);
    await live.call('flux_update_doc', { docId: page.id, expectedVersion: second.current_version, changes: { body: 'Measured at night' } });
    await live.call('flux_update_task', { workId: job.id, expectedVersion: job.version, changes: { status: 'in_progress' } });
    await scene.complete(live.runId);
    const before = await scene.docBody(page.id);
    assert.equal(before.body, 'Measured at night');

    const made = (await scene.listConversation(scene.owner)).filter((change) => change.runId === live.runId);
    assert.equal(assistantChangeLine(made), `Updated the Wiki page Calibration (2 changes) · moved #${job.number} to In progress`);
    // Anyone who may edit can undo; a viewer's copy offers nothing and the server refuses.
    assert.ok((await scene.listConversation(scene.viewer)).filter((change) => change.runId === live.runId).every((change) => !change.undoable));
    assert.equal((await scene.viewer.browser.request('POST', assistantRunChangesActionPath(live.runId, 'undo'), { body: {} })).status, 403);

    const undone = await undoRun(scene.peer, live.runId);
    assert.equal(undone.undone, 3, undone.message);
    const after = await scene.docBody(page.id);
    assert.equal(after.body, 'Measured at noon', 'the earlier text is back');
    assert.ok(after.current_version > before.current_version, 'as a new version: history keeps what happened');
    assert.notEqual((await scene.taskRow(job.id)).status, 'in_progress');
    const lines = (await scene.listConversation(scene.owner)).filter((change) => change.runId === live.runId);
    assert.ok(lines.every((change) => change.state === 'undone' && change.decidedBy?.id === scene.peer.id && !change.undoable));
  });

  test('an agent never decides: no tool to approve or accept, and every run or client token is refused at each decision route', async () => {
    const theirs = await scene.task(scene.peer, 'Jonas waits');
    const live = await scene.liveRun();
    await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Changed by the agent' } });
    const [row] = await changesOf(live.runId);
    assert.ok(!live.tools.some((name) => /approve|apply|skip|accept|decide|may_do/.test(name)), 'not one tool decides');
    const other = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada laptop', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, other, [scene.place.id]);
    assert.ok(!(await client.toolNames()).some((name) => /approve|apply_change|skip|accept|may_do/.test(name)), 'nor a client');
    for (const bearer of [live.token, client.accessToken]) {
      for (const [method, path, body] of [['POST', assistantChangeActionPath(row!.id, 'apply'), {}], ['POST', assistantChangeActionPath(row!.id, 'skip'), {}],
        ['POST', assistantChangeActionPath(row!.id, 'edit'), { expectedVersion: row!.version, title: 'x' }], ['POST', assistantRunChangesActionPath(live.runId, 'apply'), {}],
        ['PATCH', agentConnectionPath(client.connectionId), { mayDo: 'act' }]] as const) {
        const response = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.ok(response.status === 401 || response.status === 403, `${method} ${path}: ${response.status}`);
      }
    }
    assert.equal((await changesOf(live.runId))[0]!.state, 'waiting');
    // Only the owner sets "What it may do": another member, or even the workspace's admin, finds no such connection.
    for (const who of [scene.peer, scene.admin])
      assert.equal((await who.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo: 'read' } })).status, 404);
  });

  test('an agent has no more than its owner, at once: kept out mid-run, the assistant and a local client both lose the project, and a saved change stays closed', async () => {
    const theirs = await scene.task(scene.peer, 'Jonas keeps this');
    const other = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada desk', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, other, [scene.place.id]);
    const allowed = await client.grant('work.create', 'execute');
    const live = await scene.liveRun();
    await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Saved before the owner left' } });
    const [saved] = await changesOf(live.runId);
    await keptOut(async () => {
      const refused = (answer: { status: number; message: Parameters<typeof result>[0] }) => answer.status !== 200 || result(answer.message)?.isError === true;
      assert.ok(refused(await live.call('flux_create_task', { task: { title: 'After the owner lost it' } })), 'the run cannot write');
      assert.ok(refused(await live.call('flux_get_conversation', { conversationId: scene.thread.id })), 'nor read');
      assert.ok(refused(await client.raw('flux_create_task', { projectId: scene.place.id, runtimeSessionId: client.runtimeSessionId, grantId: allowed.id, clientCommandId: randomUUID(),
        peerRequestClass: 'execute', sources: [], task: { title: 'After the owner lost it' } })), 'the client\'s standing grant is no way round');
      assert.equal((await decide(scene.owner, saved!.id, 'apply')).status, 403);
    });
    assert.equal((await titled('After the owner lost it')).length, 0);
    assert.equal((await decide(scene.owner, saved!.id, 'apply')).status, 409, 'getting the project back does not revive the saved change');
    assert.equal((await scene.taskRow(theirs.id)).title, 'Jonas keeps this');
  });

  test('a local client cannot wait yet, so each rule fails closed: Only read, Ask me first, a deletion, others\' things and a task for someone else change nothing', async () => {
    const other = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada review laptop', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, other, [scene.place.id]);
    const call = async (name: string, operation: Parameters<typeof client.grant>[0], peerRequestClass: 'execute' | 'plan', args: Record<string, unknown>) =>
      client.tool(name, { projectId: scene.place.id, runtimeSessionId: client.runtimeSessionId, grantId: (await client.grant(operation, peerRequestClass)).id, clientCommandId: randomUUID(),
        peerRequestClass, sources: [], ...args });
    const create = (task: Record<string, unknown>) => call('flux_create_task', 'work.create', 'execute', { task });

    assert.equal(refusal(await create({ title: 'For Jonas from a client', ownerUserId: scene.peer.id })), 'AGENT_CHANGE_WAITS');
    assert.equal((await titled('For Jonas from a client')).length, 0);
    const theirs = await scene.task(scene.peer, 'Jonas owns this');
    assert.equal(refusal(await call('flux_update_task', 'work.update', 'execute', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Changed by a client' } })), 'AGENT_CHANGE_WAITS');
    assert.equal((await scene.taskRow(theirs.id)).title, 'Jonas owns this');
    const sketch = await scene.map(scene.owner);
    const item = await thought(scene.owner, sketch.id, 'My own thought');
    assert.equal(refusal(await call('flux_remove_thought', 'map.thought.delete', 'plan', { mapId: sketch.id, thoughtId: item.id, expectedVersion: item.version })), 'AGENT_CHANGE_WAITS');
    assert.equal(await thoughtExists(item.id), true, 'deleting always waits, even what is yours');

    for (const [mayDo, code] of [['read', 'AGENT_ONLY_READS'], ['ask', 'AGENT_ASKS_FIRST']] as const) {
      expectStatus(await scene.owner.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo } }), 200);
      assert.equal(refusal(await create({ title: `Client in ${mayDo}` })), code);
      assert.equal((await titled(`Client in ${mayDo}`)).length, 0);
    }
    expectStatus(await scene.owner.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo: 'act' } }), 200);
    assert.ok(toolValue(await create({ title: 'Client acting' })).workId, 'what is new and its owner\'s own is still made at once');
  });

  test('outside its owner\'s rights the assistant is refused and prepares nothing: an owner narrowed to viewer mid-run, and nothing waits', async () => {
    const own = await assistantScene('wd2');
    const lab = await createWorkspace(own.peer, 'Jonas lab');
    await addMember(own.peer, lab.id, own.owner, 'member');
    const rig = await createProject(own.peer, lab.id, 'Shared rig', 'restricted');
    await grant(own.peer, rig.id, own.owner, 'contributor');
    const agentId = (expectStatus(await own.owner.browser.request('POST', `/api/v1/workspaces/${lab.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    await own.runs.selectAgent(human(own.owner), { agentId });
    const thread = expectStatus(await own.peer.browser.request('POST', `/api/v1/projects/${rig.id}/conversations`, { body: { body: 'Rig notes', clientMessageId: randomUUID() } }), 201) as Conversation;
    const job = await own.task(own.peer, 'Jonas aligns the rig', rig.id);
    const live = await own.liveRun(thread);
    await grant(own.peer, rig.id, own.owner, 'viewer');
    const refused = await live.call('flux_update_task', { workId: job.id, expectedVersion: job.version, changes: { title: 'Aligned by a viewer\'s agent' } });
    assert.match(text(refused.message), /^My owner can't change this, so neither can I/);
    assert.equal((await own.taskRow(job.id)).title, 'Jonas aligns the rig');
    assert.deepEqual((await changesOf(live.runId)).map((row) => row.state), ['refused'], 'nothing waits for an OK the owner could not give');
  });
});
