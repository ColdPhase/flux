import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { agentConnectionPath, assistantChangeActionPath, type TaskDiscussion } from '@flux/contracts';
import { pool } from './support/db.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, approveWaiting, waits } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { text } from './support/assistant-scene.js';

// #1419 (coordinator decision 2026-11-13, under the founder's rule "Ask me first covers changes in Flux"): "Only read" is gone, and a
// local client left on it is Ask me first (migration 0073; released-databases proves the stored value). Under Ask me first a client's own
// work that other people see or that changes shared Flux state waits for its owner's OK like any change: a line in a task's discussion, a
// question to someone else, a proposal, taking a task, and claiming, pausing and finishing a unit (C-18, LC-2, AG-3). A question to the
// owner alone never waits: asking the owner is how the client gets its OK. Everything goes through the real `/mcp` route with the client's
// OAuth token; the owner's Approve repeats the exact call, and the store is read back.

let f: Awaited<ReturnType<typeof actionScene>>;
let owner: Person;
let jonas: Person;
const envelope = (clientCommandId: string = randomUUID()) =>
  ({ projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId, peerRequestClass: 'execute', sources: [] });
const setMayDo = async (mayDo: 'act' | 'ask') => expectStatus(await f.owner.request('PATCH', agentConnectionPath(f.connectionId), { body: { mayDo } }), 200);
const waiting = async () => (await pool.query(`SELECT id, operation, tool, wait_reason, object_title FROM assistant_changes WHERE connection_id = $1 AND state = 'waiting' ORDER BY created_at, id`,
  [f.connectionId])).rows as { id: string; operation: string; tool: string; wait_reason: string; object_title: string }[];
const task = async (title: string) => expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title } }), 201) as unknown as { id: string; version: number };
const lines = async (taskId: string) => (expect(await f.owner.request('GET', `/api/v1/work/${taskId}/discussion`), 200) as unknown as TaskDiscussion).messages;
const unit = async (unitId: string) => (await pool.query(`SELECT state, version, generation, lease_id FROM cowork_units WHERE id = $1`, [unitId])).rows[0] as
  { state: string; version: number; generation: number; lease_id: string | null };
const count = async (sql: string, values: unknown[]) => Number((await pool.query(sql, values)).rows[0].n);

describe('A former Only-read local client under Ask me first: its own work waits for the owner\'s OK (#1419)', () => {
  before(async () => {
    f = await actionScene(pool);
    const me = expectStatus(await f.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    owner = { id: me.user.id, email: '', browser: f.owner };
    jonas = await person('Jonas');
    await addMember(owner, f.workspaceId, jonas, 'member');
    await grant(owner, f.projectId, jonas, 'contributor');
    // What 0073 leaves for a client that was set to Only read on v0.2.0.
    await pool.query(`UPDATE agent_connections SET may_do = 'ask' WHERE id = $1`, [f.connectionId]);
  });

  test('a line in a task\'s discussion waits; Approve writes it once, as the client\'s agent, with its owner\'s delete', async () => {
    const item = await task('Measure the lamp');
    const command = randomUUID();
    const discuss = () => f.tool('flux_discuss_task', { ...envelope(command), taskId: item.id, body: 'The baseline is four hours.' });
    assert.ok(waits(await discuss()), 'the client is told it waits');
    assert.equal((await lines(item.id)).length, 0, 'nobody reads it yet');
    const [row] = await waiting();
    assert.deepEqual([row!.tool, row!.operation, row!.wait_reason], ['flux_discuss_task', 'conversation.reply', 'ask']);
    assert.match(text(await discuss()), /waiting for your owner's OK/, 'a retry still waits, and keeps one waiting change');
    assert.equal((await waiting()).length, 1);
    await approveWaiting(pool, f.owner, f.connectionId, 'conversation.reply');
    const written = await lines(item.id);
    assert.deepEqual(written.map((message) => message.body), ['The baseline is four hours.']);
    const [made] = (await pool.query(`SELECT state, authority, receipt FROM assistant_changes WHERE id = $1`, [row!.id])).rows as
      { state: string; authority: string; receipt: { undo?: { plan?: { kind?: string; thread?: boolean } } } }[];
    assert.deepEqual([made!.state, made!.authority, made!.receipt.undo?.plan?.thread], ['applied_after_wait', 'owner_approval', true]);
    assert.equal(toolValue(await discuss()).replayed, true, 'the client\'s retry after Approve finds the line made, not a second one');
    assert.equal((await lines(item.id)).length, 1);
  });

  test('a question to Jonas waits; a question to its owner is asked at once', async () => {
    const thread = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`,
      { body: { body: 'Offsets for the bed probe', clientMessageId: randomUUID() } }), 201) as unknown as { id: string };
    const ask = (askUserId?: string) => f.tool('flux_ask_question', { ...envelope(), conversationId: thread.id, question: 'Per bed, or one value?',
      options: ['Per bed', 'One value'], ...(askUserId ? { askUserId } : {}) });
    const questions = () => count(`SELECT count(*)::int AS n FROM agent_questions WHERE conversation_id = $1`, [thread.id]);
    assert.ok(waits(await ask(jonas.id)), 'asking another person waits');
    assert.equal(await questions(), 0, 'Jonas is not asked yet');
    const toOwner = toolValue(await ask());
    assert.ok(toOwner.questionId, 'asking the owner is how the client gets its OK: it never waits');
    assert.ok(toolValue(await ask(owner.id)).questionId, 'the owner named explicitly is the same');
    assert.equal(await questions(), 2);
    const [row] = (await waiting()).filter((change) => change.tool === 'flux_ask_question');
    expectStatus(await f.owner.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 200);
    assert.equal(await questions(), 3, 'Approve asks Jonas');
    assert.equal(await count(`SELECT count(*)::int AS n FROM agent_questions WHERE conversation_id = $1 AND asked_user_id = $2`, [thread.id, jonas.id]), 1);
  });

  test('a proposal waits, and Approve makes it', async () => {
    const proposals = () => count(`SELECT count(*)::int AS n FROM agent_proposals WHERE project_id = $1`, [f.projectId]);
    const answer = await f.tool('flux_create_proposal', { projectId: f.projectId, materialId: f.source.materialId, version: f.source.version,
      clientCommandId: randomUUID(), fact: 'Battery lasts four hours', interpretation: 'Runtime may be short', suggestedAction: 'Compare another battery' });
    assert.ok(waits(answer));
    assert.equal(await proposals(), 0);
    const [row] = (await waiting()).filter((change) => change.tool === 'flux_create_proposal');
    assert.equal(row!.object_title, 'Compare another battery');
    expectStatus(await f.owner.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 200);
    assert.equal(await proposals(), 1);
  });

  test('taking a task, claiming, pausing and finishing a unit each wait; each Approve makes exactly that step', async () => {
    // The outcome record the unit will name, made while the switch is off.
    await setMayDo('act');
    const outcome = toolValue(await f.tool('flux_create_doc', { ...envelope(), doc: { title: 'Lamp baseline', body: 'Four hours, measured twice.' } }));
    await setMayDo('ask');
    const item = await task('Measure the baseline again');
    assert.ok(waits(await f.tool('flux_create_unit', { ...envelope(), taskId: item.id, unitKey: 'take', expectedTaskVersion: item.version,
      assignmentConnectionId: f.connectionId, parent: null })), 'taking a task waits');
    assert.equal(await count(`SELECT count(*)::int AS n FROM cowork_units WHERE work_id = $1`, [item.id]), 0);
    const taken = await approveWaiting(pool, f.owner, f.connectionId, 'cowork.unit.create') as { unitId: string; version: number };
    assert.equal((await unit(taken.unitId)).state, 'pending');

    assert.ok(waits(await f.tool('flux_claim_unit', { ...envelope(), unitId: taken.unitId, expectedVersion: taken.version })), 'claiming waits');
    assert.equal((await unit(taken.unitId)).state, 'pending');
    const [claimRow] = await waiting();
    assert.deepEqual([claimRow!.operation, claimRow!.object_title], ['cowork.claim', `#${(await pool.query('SELECT number FROM project_work_items WHERE id = $1', [item.id])).rows[0].number} Measure the baseline again`]);
    await approveWaiting(pool, f.owner, f.connectionId, 'cowork.claim');
    const claimed = await unit(taken.unitId);
    assert.equal(claimed.state, 'claimed');
    const fence = () => ({ unitId: taken.unitId, expectedVersion: claimed.version, generation: claimed.generation, leaseId: claimed.lease_id });

    assert.ok(waits(await f.tool('flux_release_unit', { ...envelope(), ...fence(),
      checkpoint: { summary: 'Measured once.', nextAction: 'Measure again.', blocker: null } })), 'pausing waits');
    assert.equal((await unit(taken.unitId)).state, 'claimed');
    await approveWaiting(pool, f.owner, f.connectionId, 'cowork.release');
    assert.equal((await unit(taken.unitId)).state, 'paused');

    const paused = await unit(taken.unitId);
    assert.ok(waits(await f.tool('flux_claim_unit', { ...envelope(), unitId: taken.unitId, expectedVersion: paused.version })));
    await approveWaiting(pool, f.owner, f.connectionId, 'cowork.claim');
    const again = await unit(taken.unitId);
    assert.ok(waits(await f.tool('flux_complete_unit', { ...envelope(), unitId: taken.unitId, expectedVersion: again.version, generation: again.generation,
      leaseId: again.lease_id, outcome: { type: 'doc', id: outcome.docId, version: outcome.version } })), 'finishing waits');
    assert.equal((await unit(taken.unitId)).state, 'claimed');
    await approveWaiting(pool, f.owner, f.connectionId, 'cowork.unit.complete');
    assert.equal((await unit(taken.unitId)).state, 'completed');
    assert.equal((await waiting()).length, 0, 'nothing is left waiting');
  });

  test('with the switch off the same work is made at once, as before', async () => {
    await setMayDo('act');
    const item = await task('Straight away');
    assert.ok(!waits(await f.tool('flux_discuss_task', { ...envelope(), taskId: item.id, body: 'On it.' })));
    assert.equal((await lines(item.id)).length, 1);
    await setMayDo('ask');
  });
});
