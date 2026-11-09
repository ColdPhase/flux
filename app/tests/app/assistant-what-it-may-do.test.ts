import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  agentConnectionPath, assistantChangeActionPath, assistantChangeLine, ASSISTANT_RUN_EFFECT_TOOLS, assistantRunChangesActionPath, assistantRunChangesPath, docPath, NEEDS_YOU_PATH,
  type AssistantChange, type AssistantChangeDecision, type AssistantRunUndone, type Conversation, type NeedsYouResponse,
} from '@flux/contracts';
import { pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { toolValue } from './support/mcp.js';
import { agentConnection } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, removeFromSpace, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { assistantScene, changesOf, human, result, text, type AssistantScene } from './support/assistant-scene.js';

// F-036 AG-3 and AG-7 (#855): an agent's rights are exactly its owner's, and its "What it may do" (Only read, Do it and tell me, Ask me
// first) decides what happens within them. Deleting and other people's things always wait; only the owner decides, in their own session;
// Undo sits on the agent's message and restores the earlier versions; the Inbox holds one item per run. Run changes go through the real
// `/mcp` route with the run's own token, and every state is read back from the store. Fake engines stand in for every vendor.

let scene: AssistantScene;
const decide = (who: Person, id: string, action: 'apply' | 'skip' | 'edit', body: unknown = {}) => who.browser.request('POST', assistantChangeActionPath(id, action), { body });
const undoRun = async (who: Person, runId: string) => expectStatus(await who.browser.request('POST', assistantRunChangesActionPath(runId, 'undo'), { body: {} }), 200) as AssistantRunUndone;
const ownItems = async (who: Person = scene.owner) => (expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.filter((item) => item.key.startsWith('assistant:'));
const titled = async (title: string, projectId = scene.place.id) => (await pool.query(`SELECT id, owner_user_id FROM project_work_items WHERE title = $1 AND project_id = $2`, [title, projectId])).rows as { id: string; owner_user_id: string | null }[];
const thought = async (who: Person, mapId: string, value: string) => {
  const made = expectStatus(await who.browser.request('POST', `/api/v1/sketches/${mapId}/thoughts`, { body: { text: value, x: 0, y: 0 } }), 201) as { thought?: { id: string; version: number }; id?: string; version?: number };
  return { id: (made.thought?.id ?? made.id)!, version: (made.thought?.version ?? made.version)! };
};
const thoughtExists = async (id: string) => (await pool.query(`SELECT count(*)::int AS n FROM sketch_thoughts WHERE id = $1`, [id])).rows[0].n === 1;
const refusal = (message: Parameters<typeof text>[0]) => (JSON.parse(text(message)) as { code?: string }).code;
/** Refused either way: a tool error, or an HTTP refusal for a bearer that lost everything. */
const refused = (answer: { status: number; message: Parameters<typeof result>[0] }) => answer.status !== 200 || result(answer.message)?.isError === true;
const rename = async (who: Person, sketchId: string, version: number, title: string) =>
  expectStatus(await who.browser.request('PATCH', `/api/v1/sketches/${sketchId}`, { body: { title }, headers: { 'if-match': `"${version}"` } }), 200) as { version: number };
const rewrite = async (who: Person, sketchId: string, item: { id: string; version: number }, value: string) =>
  expectStatus(await who.browser.request('PATCH', `/api/v1/sketches/${sketchId}/thoughts/${item.id}`, { body: { text: value }, headers: { 'if-match': `"${item.version}"` } }), 200) as { id: string; version: number };
const thoughtText = async (id: string) => (await pool.query(`SELECT text FROM sketch_thoughts WHERE id = $1`, [id])).rows[0]?.text as string | undefined;
/** A second company where the scene's owner is an ordinary member with an assistant: Jonas owns it, and Ada's rights there can change. */
async function laboratory(own: AssistantScene) {
  const lab = await createWorkspace(own.peer, 'Jonas lab');
  await addMember(own.peer, lab.id, own.owner, 'member');
  const rig = await createProject(own.peer, lab.id, 'Shared rig', 'restricted');
  await grant(own.peer, rig.id, own.owner, 'contributor');
  const newAgent = async (name: string) => (expectStatus(await own.owner.browser.request('POST', `/api/v1/workspaces/${lab.id}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
  await own.runs.enable(human(own.owner), { agentId: await newAgent('Ada assistant') });
  const thread = expectStatus(await own.peer.browser.request('POST', `/api/v1/projects/${rig.id}/conversations`, { body: { body: 'Rig notes', clientMessageId: randomUUID() } }), 201) as Conversation;
  return { lab, rig, thread, newAgent };
}
/** The owner removed from the project for the length of one check: the one way to lower the scene's owner, who is an ordinary member (#903). */
async function keptOut(work: () => Promise<void>) {
  await removeFromSpace(scene.lead, scene.place.id, scene.owner);
  try { await work(); }
  finally { await grant(scene.lead, scene.place.id, scene.owner, 'manager'); }
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

  test('deleting a page waits for the OK in both modes; [Delete] removes it for everyone and [Keep] leaves it (#941)', async () => {
    const pageExists = async (id: string) => (await pool.query('SELECT 1 FROM project_materials WHERE id = $1', [id])).rowCount === 1;
    for (const mode of ['act', 'ask'] as const) {
      await scene.setMayDo(mode);
      const stays = await scene.doc(scene.owner, `Stays in ${mode}`);
      const goes = await scene.doc(scene.owner, `Goes in ${mode}`);
      const live = await scene.liveRun();
      for (const item of [stays, goes])
        assert.match(text((await live.call('flux_delete_doc', { docId: item.id, expectedVersion: item.version })).message), /^Waiting for /, mode);
      await scene.complete(live.runId);
      const rows = await changesOf(live.runId);
      assert.deepEqual(rows.map((row) => [row.operation, row.state, row.wait_reason]), [['doc.delete', 'waiting', 'removal'], ['doc.delete', 'waiting', 'removal']], mode);
      assert.ok(await pageExists(stays.id) && await pageExists(goes.id), 'nothing is deleted before the OK');
      assert.equal((await scene.listConversation(scene.owner)).find((change) => change.id === rows[0]!.id)?.line, 'Deleting always waits for your OK.');
      const keep = rows.find((row) => row.object_id === stays.id)!;
      const remove = rows.find((row) => row.object_id === goes.id)!;
      assert.equal((expectStatus(await decide(scene.owner, keep.id, 'skip', { expectedVersion: keep.version }), 200) as { change: { line: string } }).change.line, 'Kept');
      const done = expectStatus(await decide(scene.owner, remove.id, 'apply', { expectedVersion: remove.version }), 200) as { change: { state: string; undoable: boolean } };
      assert.deepEqual([done.change.state, done.change.undoable], ['applied_after_wait', false], 'a deleted page has nothing to undo');
      assert.equal(await pageExists(stays.id), true);
      assert.equal(await pageExists(goes.id), false);
    }
  });

  test('other people\'s things wait; what you or any of your agents made is yours, until someone else edits it', async () => {
    const theirs = await scene.task(scene.peer, 'Jonas calibrates');
    const otherAgent = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada Codex', owner: 'self' } }), 201) as { id: string }).id;
    const byMyAgent = await scene.task(scene.owner, 'Made by my other agent');
    await pool.query(`UPDATE project_work_items SET created_by_kind = 'agent', created_by_id = $2 WHERE id = $1`, [byMyAgent.id, otherAgent]);
    const page = await scene.doc(scene.owner, 'Shared notes');
    const edited = await scene.doc(scene.owner, 'Edited by Jonas');
    expectStatus(await scene.peer.browser.request('PATCH', docPath(edited.id), { body: { body: 'Jonas wrote this' }, headers: { 'if-match': `"${edited.version}"` } }), 200);
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
    assert.equal(assistantChangeLine(made), `Updated the Wiki page Calibration (2 changes) · moved #${job.number} to Doing`);
    // Anyone who may edit can undo; someone outside the space sees nothing and the server refuses.
    assert.equal((await scene.stranger.browser.request('POST', assistantRunChangesActionPath(live.runId, 'undo'), { body: {} })).status, 404);

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
    const live = await scene.liveRun();
    await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Saved before the owner left' } });
    const [saved] = await changesOf(live.runId);
    await keptOut(async () => {
      assert.ok(refused(await live.call('flux_create_task', { task: { title: 'After the owner lost it' } })), 'the run cannot write');
      assert.ok(refused(await live.call('flux_get_conversation', { conversationId: scene.thread.id })), 'nor read');
      assert.ok(refused(await client.raw('flux_create_task', { projectId: scene.place.id, runtimeSessionId: client.runtimeSessionId, clientCommandId: randomUUID(),
        peerRequestClass: 'execute', sources: [], task: { title: 'After the owner lost it' } })), 'the client\'s standing grant is no way round');
      assert.equal((await decide(scene.owner, saved!.id, 'apply')).status, 403);
    });
    assert.equal((await titled('After the owner lost it')).length, 0);
    assert.equal((await decide(scene.owner, saved!.id, 'apply')).status, 409, 'getting the project back does not revive the saved change');
    assert.equal((await scene.taskRow(theirs.id)).title, 'Jonas keeps this');
  });

  test('a local client waits like the assistant: Only read changes nothing; Ask me first, a deletion, others\' things and a task for someone else wait', async () => {
    const other = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada review laptop', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, other, [scene.place.id]);
    const call = (name: string, args: Record<string, unknown>) => client.tool(name, { projectId: scene.place.id, clientCommandId: randomUUID(), sources: [], ...args });
    const create = (task: Record<string, unknown>) => call('flux_create_task', { task });
    const waits = (message: Parameters<typeof text>[0]) => /^Waiting for /.test(text(message));

    assert.ok(waits(await create({ title: 'For Jonas from a client', ownerUserId: scene.peer.id })));
    assert.equal((await titled('For Jonas from a client')).length, 0);
    const theirs = await scene.task(scene.peer, 'Jonas owns this');
    assert.ok(waits(await call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Changed by a client' } })));
    assert.equal((await scene.taskRow(theirs.id)).title, 'Jonas owns this');
    const sketch = await scene.map(scene.owner);
    const item = await thought(scene.owner, sketch.id, 'My own thought');
    assert.ok(waits(await call('flux_remove_thought', { mapId: sketch.id, thoughtId: item.id, expectedVersion: item.version })));
    assert.equal(await thoughtExists(item.id), true, 'deleting always waits, even what is yours');

    expectStatus(await scene.owner.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo: 'read' } }), 200);
    assert.equal(refusal(await create({ title: 'Client in read' })), 'AGENT_ONLY_READS');
    expectStatus(await scene.owner.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo: 'ask' } }), 200);
    assert.ok(waits(await create({ title: 'Client in ask' })));
    assert.equal((await titled('Client in read')).length + (await titled('Client in ask')).length, 0);
    expectStatus(await scene.owner.browser.request('PATCH', agentConnectionPath(client.connectionId), { body: { mayDo: 'act' } }), 200);
    assert.ok(toolValue(await create({ title: 'Client acting' })).workId, 'what is new and its owner\'s own is still made at once');
  });

  test('outside its owner\'s rights the assistant is refused and prepares nothing: an owner removed from the space mid-run, and nothing waits', async () => {
    const own = await assistantScene('wd2');
    const { rig, thread } = await laboratory(own);
    const job = await own.task(own.peer, 'Jonas aligns the rig', rig.id);
    const live = await own.liveRun(thread);
    await removeFromSpace(own.peer, rig.id, own.owner);
    // The space is gone from the owner's view, so the run's own access is refused before any tool runs (as for a revoked connection).
    const answer = await live.call('flux_update_task', { workId: job.id, expectedVersion: job.version, changes: { title: 'Aligned after its owner left' } });
    assert.ok(refused(answer), 'the call is refused');
    assert.equal((await own.taskRow(job.id)).title, 'Jonas aligns the rig');
    assert.deepEqual(await changesOf(live.runId), [], 'nothing was prepared and nothing waits for an OK the owner could not give');
  });

  test('a guest has no AI, at once, even with a grant on the space: a client, a running assistant, a queued run, saved changes and the Inbox all stop', async (t) => {
    const own = await assistantScene('wg');
    const { lab, rig, thread, newAgent } = await laboratory(own);
    const mine = await own.task(own.owner, 'Ada wires the rig', rig.id);
    const [first, second] = [await own.task(own.peer, 'Jonas aligns the rig', rig.id), await own.task(own.peer, 'Jonas cleans the rig', rig.id)];
    const client = await agentConnection(pool, own.owner.browser, await newAgent('Ada desk'), [rig.id]);
    const clientCreate = (title: string) => client.raw('flux_create_task', { projectId: rig.id, runtimeSessionId: client.runtimeSessionId, clientCommandId: randomUUID(),
      peerRequestClass: 'execute', sources: [], task: { title } });
    assert.ok(!refused(await clientCreate('Client before the change')), 'it works while Ada is a member');
    const saved = await own.liveRun(thread);
    for (const task of [first, second]) assert.match(text((await saved.call('flux_update_task', { workId: task.id, expectedVersion: task.version, changes: { title: 'Done by a guest\'s agent' } })).message), /^Waiting for /);
    await own.complete(saved.runId);
    const [one, other] = await changesOf(saved.runId);
    assert.equal((await ownItems(own.owner)).length, 1, 'it waits for her');
    // A second run in the same thread, so one waiting change can be approved after she is a member again without touching the two above.
    const third = await own.task(own.peer, 'Jonas trims the rig', rig.id);
    const later = await own.liveRun(thread);
    assert.match(text((await later.call('flux_update_task', { workId: third.id, expectedVersion: third.version, changes: { title: 'Trimmed by a guest\'s agent' } })).message), /^Waiting for /);
    await own.complete(later.runId);
    const [kept] = await changesOf(later.runId);
    const waitingInThread = async () => (await own.listConversation(own.owner, thread)).filter((change) => change.state === 'waiting').map((change) => change.id).sort();
    const waitingOnRun = async (runId: string) => ((expectStatus(await own.owner.browser.request('GET', assistantRunChangesPath(runId)), 200) as { items: AssistantChange[] }).items)
      .filter((change) => change.state === 'waiting').map((change) => change.id).sort();
    const becomes = async (role: 'guest' | 'member') => expectStatus(await own.peer.browser.request('PATCH', `/api/v1/workspaces/${lab.id}/members/${own.owner.id}`, { body: { role } }), 200);
    const running = await own.liveRun(thread);
    const queued = await own.runs.invoke(human(own.owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Check the rig' });

    await becomes('guest');

    await t.test('the local client can neither write nor read', async () => {
      assert.ok(refused(await clientCreate('Client after the change')), 'write');
      assert.ok(refused(await client.raw('flux_get_work', { projectId: rig.id, id: mine.id })), 'read');
      assert.equal((await titled('Client after the change', rig.id)).length, 0);
    });
    await t.test('the running assistant can neither write nor read on its next call', async () => {
      assert.ok(refused(await running.call('flux_create_task', { task: { title: 'Run after the change' } })), 'write');
      assert.ok(refused(await running.call('flux_get_work', { projectId: rig.id, id: mine.id })), 'read');
      assert.equal((await titled('Run after the change', rig.id)).length, 0);
    });
    await t.test('a queued run never starts', async () => {
      await own.complete(running.runId);
      assert.equal(await own.processor.process(queued.run.id), 'revoked');
    });
    await t.test('nothing waits for a guest in the Inbox', async () => {
      assert.deepEqual(await ownItems(own.owner), []);
      assert.equal((await changesOf(saved.runId))[0]!.state, 'waiting');
    });
    await t.test('a guest is offered no waiting change, in the conversation or on its run, and the change itself stays waiting', async () => {
      assert.deepEqual(await waitingInThread(), []);
      assert.deepEqual([await waitingOnRun(saved.runId), await waitingOnRun(later.runId)], [[], []]);
      assert.deepEqual([...await changesOf(saved.runId), ...await changesOf(later.runId)].map((row) => row.state), ['waiting', 'waiting', 'waiting']);
    });
    await t.test('as a member again the same changes are offered again, and one still works', async () => {
      await becomes('member');
      assert.deepEqual(await waitingInThread(), [one!.id, other!.id, kept!.id].sort());
      assert.deepEqual([await waitingOnRun(saved.runId), await waitingOnRun(later.runId)], [[one!.id, other!.id].sort(), [kept!.id]]);
      assert.equal((await ownItems(own.owner)).length, 2, 'both runs wait for her in the Inbox again');
      expectStatus(await decide(own.owner, kept!.id, 'apply', { expectedVersion: kept!.version }), 200);
      assert.equal((await own.taskRow(third.id)).title, 'Trimmed by a guest\'s agent');
      assert.equal((await changesOf(later.runId))[0]!.state, 'applied_after_wait');
      await becomes('guest');
      assert.deepEqual([await waitingInThread(), await waitingOnRun(saved.runId)], [[], []], 'and a guest again is offered nothing');
      assert.deepEqual((await changesOf(saved.runId)).map((row) => row.state), ['waiting', 'waiting']);
    });
    await t.test('Approve and Approve all change nothing and close the saved changes', async () => {
      assert.equal((await decide(own.owner, one!.id, 'apply', { expectedVersion: one!.version })).status, 403);
      const all = expectStatus(await own.owner.browser.request('POST', assistantRunChangesActionPath(saved.runId, 'apply'), { body: {} }), 200) as { changes: AssistantChangeDecision[] };
      assert.ok(all.changes.every((decided) => !!decided.message), 'Approve all says why');
      assert.deepEqual((await changesOf(saved.runId)).map((row) => [row.id, row.state]), [[one!.id, 'refused'], [other!.id, 'refused']]);
      assert.deepEqual([(await own.taskRow(first.id)).title, (await own.taskRow(second.id)).title], ['Jonas aligns the rig', 'Jonas cleans the rig']);
    });
    await t.test('the person keeps their own access; only AI stops', async () => {
      assert.ok((await own.task(own.owner, 'Ada still works by hand', rig.id)).id);
    });
  });

  test('AST-5.3: a run changes only its place: every change that names something in another space is refused like reading it, nothing waits and nothing is recorded', async () => {
    const vault = await createProject(scene.owner, scene.ws.id, 'Vault', 'restricted');
    const SECRET = 'Vault combination';
    const task = await scene.task(scene.owner, SECRET, vault.id);
    const page = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${vault.id}/docs`, { body: { title: SECRET, body: 'Vault page' } }), 201) as { id: string; version: number };
    const map = expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/sketches`, { body: { title: SECRET, scope: 'project', projectId: vault.id } }), 201) as { id: string; version: number };
    const [from, to] = [await thought(scene.owner, map.id, SECRET), await thought(scene.owner, map.id, 'Second vault thought')];
    const link = expectStatus(await scene.owner.browser.request('POST', `/api/v1/sketches/${map.id}/links`, { body: { fromId: from.id, toId: to.id } }), 201) as { id: string };
    const talk = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${vault.id}/conversations`, { body: { body: SECRET, clientMessageId: randomUUID() } }), 201) as Conversation;
    const here = await scene.map(scene.owner, 'Map of this place');
    const elsewhere = { projectId: vault.id };
    const moved = [{ id: from.id, x: 5, y: 5, expectedVersion: from.version }];
    const changes: [string, Record<string, unknown>][] = [
      // What the run names by its id, in another space.
      ['flux_update_task', { workId: task.id, expectedVersion: task.version, changes: { title: 'Changed from outside' } }],
      ['flux_update_doc', { docId: page.id, expectedVersion: page.version, changes: { body: 'Changed from outside' } }],
      ['flux_delete_doc', { docId: page.id, expectedVersion: page.version }],
      ['flux_rename_map', { mapId: map.id, expectedVersion: map.version, title: 'Changed from outside' }],
      ['flux_add_thought', { mapId: map.id, thought: { text: 'Changed from outside', x: 1, y: 1 } }],
      ['flux_update_thought', { mapId: map.id, thoughtId: from.id, expectedVersion: from.version, changes: { text: 'Changed from outside' } }],
      ['flux_remove_thought', { mapId: map.id, thoughtId: from.id, expectedVersion: from.version }],
      ['flux_move_thoughts', { mapId: map.id, moves: moved }],
      ['flux_link_thoughts', { mapId: map.id, fromId: to.id, toId: from.id }],
      ['flux_unlink_thoughts', { mapId: map.id, linkId: link.id }],
      ['flux_create_unit', { taskId: task.id, unitKey: 'outside', expectedTaskVersion: task.version, assignmentConnectionId: await scene.assistantConnectionId(), parent: null, peerRequestClass: 'execute' }],
      // Something of another space named through this place's own map.
      ['flux_update_thought', { mapId: here.id, thoughtId: from.id, expectedVersion: from.version, changes: { text: 'Changed from outside' } }],
      ['flux_remove_thought', { mapId: here.id, thoughtId: from.id, expectedVersion: from.version }],
      ['flux_move_thoughts', { mapId: here.id, moves: moved }],
      ['flux_link_thoughts', { mapId: here.id, fromId: to.id, toId: from.id }],
      ['flux_unlink_thoughts', { mapId: here.id, linkId: link.id }],
      // Another space named outright.
      ['flux_create_task', { ...elsewhere, task: { title: 'Outside the place' } }],
      ['flux_create_doc', { ...elsewhere, doc: { title: 'Outside the place' } }],
      ['flux_create_map', { ...elsewhere, title: 'Outside the place' }],
      ['flux_propose_decision', { ...elsewhere, decision: { title: 'Outside the place' } }],
    ];
    assert.deepEqual([...new Set(changes.map(([name]) => name))].sort(), [...ASSISTANT_RUN_EFFECT_TOOLS].sort(), 'every change kind is covered');
    for (const mode of ['act', 'ask'] as const) {
      await scene.setMayDo(mode);
      const live = await scene.liveRun();
      assert.equal(refusal((await live.call('flux_get_work', { projectId: vault.id, id: task.id })).message), 'PROJECT_NOT_FOUND', 'the same run cannot read it');
      // Every kind is asked before anything is asserted, so a failure names all that got through, not only the first. (No `t.test`: this suite's beforeEach would end the run.)
      const escaped: string[] = [];
      for (const [name, args] of changes) {
        const answer = await live.call(name, args);
        const said = text(answer.message);
        if (!said.includes('"OUTSIDE_RUN_PLACE"') || said.includes(SECRET)) escaped.push(`${name} ${args.projectId ? 'elsewhere' : args.mapId === here.id ? 'through this map' : 'by id'}: ${said.slice(0, 80)}`);
      }
      assert.deepEqual(escaped, [], `${mode}: every change is refused, and says nothing of what is there`);
      assert.deepEqual(await changesOf(live.runId), [], `${mode}: nothing was applied, waits or is recorded`);
      await scene.complete(live.runId);
    }
    assert.equal((await scene.taskRow(task.id)).title, SECRET);
    assert.equal((await scene.docBody(page.id)).body, 'Vault page');
    assert.equal(await thoughtText(from.id), SECRET);
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM sketch_thoughts WHERE sketch_id = $1) AS thoughts, (SELECT count(*)::int FROM sketch_links WHERE sketch_id = $1) AS links,
      (SELECT count(*)::int FROM project_messages WHERE conversation_id = $2) AS messages, (SELECT version FROM sketches WHERE id = $1) AS version`, [map.id, talk.id])).rows[0];
    assert.deepEqual(counts, { thoughts: 2, links: 1, messages: 1, version: map.version });
    assert.equal((await pool.query(`SELECT 1 FROM project_work_items WHERE project_id = $1 AND title = 'Outside the place'`, [vault.id])).rowCount, 0);
  });

  test('a target that is gone at Approve reads "Changed since you asked", not as outside the place', async () => {
    const sketch = await scene.map(scene.owner);
    const item = await thought(scene.owner, sketch.id, 'Gone before the OK');
    await scene.setMayDo('ask');
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_update_thought', { mapId: sketch.id, thoughtId: item.id, expectedVersion: item.version, changes: { text: 'Too late' } })).message), /^Waiting for /);
    await scene.complete(live.runId);
    expectStatus(await scene.owner.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/thoughts/${item.id}`, { headers: { 'if-match': `"${item.version}"` } }), 204);
    const [saved] = await changesOf(live.runId);
    const answer = await decide(scene.owner, saved!.id, 'apply', { expectedVersion: saved!.version });
    assert.equal(answer.status, 409);
    assert.equal((answer.json as { code: string }).code, 'ASSISTANT_CHANGE_STALE');
  });

  test('a thought or a map someone else edited waits; your own and your agents\' edits keep it yours, past its first version', async () => {
    const sketch = await scene.map(scene.owner, 'Shared map');
    const shared = await thought(scene.owner, sketch.id, 'Ada wrote this');
    const rewritten = await rewrite(scene.peer, sketch.id, shared, 'Jonas rewrote this');
    const moved = await thought(scene.owner, sketch.id, 'Jonas moved this');
    const nudged = expectStatus(await scene.peer.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: moved.id, x: 40, y: 40, expectedVersion: moved.version }] } }), 200) as { thoughts: { version: number }[] };
    const kept = await thought(scene.owner, sketch.id, 'Ada keeps this');
    const edited = await rewrite(scene.owner, sketch.id, kept, 'Ada changed this herself');
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_update_thought', { mapId: sketch.id, thoughtId: shared.id, expectedVersion: rewritten.version, changes: { text: 'Overwrites Jonas' } })).message), /^Waiting for /);
    assert.match(text((await live.call('flux_move_thoughts', { mapId: sketch.id, moves: [{ id: moved.id, x: 0, y: 0, expectedVersion: nudged.thoughts[0]!.version }] })).message), /^Waiting for /);
    const first = await live.call('flux_update_thought', { mapId: sketch.id, thoughtId: kept.id, expectedVersion: edited.version, changes: { text: 'Her agent changed this' } });
    const second = await live.call('flux_update_thought', { mapId: sketch.id, thoughtId: kept.id, expectedVersion: (JSON.parse(text(first.message)) as { version: number }).version, changes: { text: 'Her agent changed this again' } });
    assert.ok(JSON.parse(text(second.message)).thoughtId, 'her agent keeps working on what stays hers');
    assert.deepEqual((await changesOf(live.runId)).map((row) => [row.operation, row.state, row.wait_reason]), [['map.thought.update', 'waiting', 'others'], ['map.positions.update', 'waiting', 'others'],
      ['map.thought.update', 'applied', null], ['map.thought.update', 'applied', null]]);
    assert.equal(await thoughtText(shared.id), 'Jonas rewrote this');
    assert.equal(await thoughtText(kept.id), 'Her agent changed this again');

    // A local client uses the same rule, and waits the same way.
    const other = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada thought laptop', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, other, [scene.place.id]);
    assert.match(text(await client.tool('flux_update_thought', { projectId: scene.place.id, clientCommandId: randomUUID(),
      sources: [], mapId: sketch.id, thoughtId: shared.id, expectedVersion: rewritten.version, changes: { text: 'Overwrites Jonas from a client' } })), /^Waiting for /);
    assert.equal(await thoughtText(shared.id), 'Jonas rewrote this');

    const yours = await scene.map(scene.owner, 'Named by Ada');
    const theirs = await scene.map(scene.owner, 'Named by Ada too');
    const renamed = await rename(scene.peer, theirs.id, theirs.version, 'Named by Jonas');
    assert.ok(JSON.parse(text((await live.call('flux_rename_map', { mapId: yours.id, expectedVersion: yours.version, title: 'Renamed by her agent' })).message)).mapId);
    assert.match(text((await live.call('flux_rename_map', { mapId: theirs.id, expectedVersion: renamed.version, title: 'Overwrites Jonas' })).message), /^Waiting for /);
  });

  test('a restricted space its owner cannot see stays out of every payload, and the connection list holds no project at all', async () => {
    const own = await assistantScene('wr');
    const { lab, rig, newAgent } = await laboratory(own);
    const hidden = await createProject(own.peer, lab.id, 'Jonas only', 'restricted');
    assert.equal((await own.owner.browser.request('GET', `/api/v1/projects/${hidden.id}`)).status, 404, 'she cannot see it');
    const client = await agentConnection(pool, own.owner.browser, await newAgent('Ada desk'), [rig.id]);
    const listed = async () => (toolValue(await client.tool('flux_list_contexts', {})).projects as { id: string }[]).map((project) => project.id);
    assert.deepEqual(await listed(), [rig.id], 'only what she can see');
    const connections = expectStatus(await own.owner.browser.request('GET', '/api/v1/agent-connections'), 200);
    assert.ok(!JSON.stringify(connections).includes(hidden.id), 'its id appears nowhere');
    assert.ok(!JSON.stringify(connections).includes('selectedProjectIds'), 'no connection carries a project list');
    // Added to the space, she reaches it at once: nothing is stored for the client.
    await grant(own.peer, hidden.id, own.owner, 'contributor');
    assert.deepEqual((await listed()).sort(), [rig.id, hidden.id].sort());
  });
});
