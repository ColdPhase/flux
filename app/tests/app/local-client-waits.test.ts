import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  agentConnectionPath, assistantChangeActionPath, assistantRunChangesActionPath, NEEDS_YOU_PATH, type AssistantRunUndone, type NeedsYouResponse,
} from '@flux/contracts';
import { loseSpace, pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { toolValue } from './support/mcp.js';
import { actionScene, agentConnection } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { text } from './support/assistant-scene.js';

// F-036 AG-3 and mcp-cowork LC-2 (#859, #855 part 2): a local client acts with its owner's rights, under the same "What it may do" as
// the assistant. Deleting and other people's things always wait, so does everything under Ask me first; only the owner approves, in their
// own signed-in session; a client's token has no way to approve its own waiting change. Everything goes through the real `/mcp` route with
// the client's own OAuth token, and every state is read back from the store.

let f: Awaited<ReturnType<typeof actionScene>>;
let owner: Person;
let peer: Person;
const setMayDo = async (mayDo: 'read' | 'act' | 'ask') => expectStatus(await f.owner.request('PATCH', agentConnectionPath(f.connectionId), { body: { mayDo } }), 200);
const create = (title: string, clientCommandId = randomUUID()) => f.tool('flux_create_task', { projectId: f.projectId, clientCommandId, task: { title } });
const rows = async () => (await pool.query(`SELECT id, state, wait_reason, refusal, authority, operation, run_id, connection_id, decided_by, client_command_id FROM assistant_changes WHERE connection_id = $1 ORDER BY created_at, id`, [f.connectionId])).rows as
  { id: string; state: string; wait_reason: string | null; refusal: string | null; authority: string | null; operation: string; run_id: string | null; connection_id: string; decided_by: string | null; client_command_id: string }[];
const titled = async (title: string) => (await pool.query(`SELECT id, owner_user_id, created_by_kind, created_by_id FROM project_work_items WHERE title = $1 AND project_id = $2`, [title, f.projectId])).rows as
  { id: string; owner_user_id: string | null; created_by_kind: string; created_by_id: string }[];
const reset = async () => { await setMayDo('act'); await pool.query(`DELETE FROM assistant_changes WHERE connection_id = $1`, [f.connectionId]); };
const decide = (who: Person, id: string, action: 'apply' | 'skip') => who.browser.request('POST', assistantChangeActionPath(id, action), { body: {} });
const inbox = async () => (expectStatus(await f.owner.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.filter((item) => item.key.startsWith('assistant:'));

describe('A local client follows the owner\'s rights and waits like the assistant (#859, #855 part 2)', () => {
  before(async () => {
    f = await actionScene(pool);
    const me = expectStatus(await f.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    owner = { id: me.user.id, email: '', browser: f.owner };
    peer = await person('Jonas');
    await addMember(owner, f.workspaceId, peer, 'member');
    await grant(owner, f.projectId, peer, 'contributor');
  });

  test('Do it and tell me (the default): a new task is made at once, as the client\'s agent, and the change is on the log with its connection', async () => {
    await reset();
    const made = toolValue(await create('Calibrate the probes'));
    assert.ok(made.workId);
    const [row] = await rows();
    assert.deepEqual([row!.state, row!.wait_reason, row!.authority, row!.run_id, row!.connection_id], ['applied', null, 'owner_request', null, f.connectionId]);
    const [task] = await titled('Calibrate the probes');
    assert.equal(task!.created_by_kind, 'agent');
  });

  test('a retry with the same command ID makes the change once', async () => {
    await reset();
    const command = randomUUID();
    const first = toolValue(await create('Retried once', command));
    const again = toolValue(await create('Retried once', command));
    assert.equal(again.workId, first.workId);
    assert.equal((await titled('Retried once')).length, 1);
    assert.equal((await rows()).length, 1);
  });

  test('Ask me first: nothing is made, the client is told it waits, and the Inbox holds one item for the client', async () => {
    await reset();
    await setMayDo('ask');
    const answer = await create('Needs my OK');
    assert.match(text(answer), /^Waiting for /);
    assert.equal((await titled('Needs my OK')).length, 0);
    assert.deepEqual((await rows()).map((row) => [row.state, row.wait_reason]), [['waiting', 'ask']]);
    await create('Also needs my OK');
    const items = await inbox();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.key, `assistant:${f.connectionId}`);
    assert.equal(items[0]!.assistantChanges?.changes.length, 2);
  });

  test('Approve makes exactly what was asked, once, and records who decided', async () => {
    await reset();
    await setMayDo('ask');
    await create('Approved task');
    const [waiting] = await rows();
    const decided = expectStatus(await decide(owner, waiting!.id, 'apply'), 200) as { change: { state: string } };
    assert.equal(decided.change.state, 'applied_after_wait');
    assert.equal((await titled('Approved task')).length, 1);
    const [after] = await rows();
    assert.deepEqual([after!.state, after!.authority, after!.decided_by], ['applied_after_wait', 'owner_approval', owner.id]);
    assert.equal((await decide(owner, waiting!.id, 'apply')).status, 409, 'a second Approve changes nothing');
    assert.equal((await titled('Approved task')).length, 1);
  });

  test('Approve all acts on the waiting changes of this client only', async () => {
    await reset();
    await setMayDo('ask');
    await create('First of two'); await create('Second of two');
    expectStatus(await f.owner.request('POST', assistantRunChangesActionPath(f.connectionId, 'apply'), { body: {} }), 200);
    assert.equal((await titled('First of two')).length + (await titled('Second of two')).length, 2);
    assert.deepEqual((await rows()).map((row) => row.state), ['applied_after_wait', 'applied_after_wait']);
  });

  test('Skip makes nothing and closes the change', async () => {
    await reset();
    await setMayDo('ask');
    await create('Skipped task');
    const [waiting] = await rows();
    expectStatus(await decide(owner, waiting!.id, 'skip'), 200);
    assert.equal((await titled('Skipped task')).length, 0);
    assert.equal((await decide(owner, waiting!.id, 'apply')).status, 409);
  });

  test('other people\'s things always wait, even under Do it and tell me', async () => {
    await reset();
    const theirs = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Jonas\'s task' } }), 201) as { id: string; version: number };
    const answer = await f.tool('flux_update_task', { projectId: f.projectId, clientCommandId: randomUUID(), workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Taken over' } });
    assert.match(text(answer), /^Waiting for /);
    assert.equal(((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [theirs.id])).rows[0] as { title: string }).title, 'Jonas\'s task');
    assert.deepEqual((await rows()).map((row) => [row.state, row.wait_reason]), [['waiting', 'others']]);
  });

  test('a task for another person waits as a proposal; one for the owner is made at once', async () => {
    await reset();
    const forPeer = await f.tool('flux_create_task', { projectId: f.projectId, clientCommandId: randomUUID(), task: { title: 'For Jonas', ownerUserId: peer.id } });
    assert.match(text(forPeer), /^Waiting for /);
    assert.equal((await titled('For Jonas')).length, 0);
    assert.ok(toolValue(await f.tool('flux_create_task', { projectId: f.projectId, clientCommandId: randomUUID(), task: { title: 'For Ada', ownerUserId: owner.id } })).workId);
  });

  test('Only read: the client reads and changes nothing, and says so', async () => {
    await reset();
    await setMayDo('read');
    const answer = await create('Never made');
    assert.equal((answer?.result as { isError?: boolean }).isError, true);
    assert.equal((JSON.parse(text(answer)) as { code: string }).code, 'AGENT_ONLY_READS');
    assert.equal((await titled('Never made')).length, 0);
    assert.equal((await rows()).length, 0);
    assert.ok(toolValue(await f.tool('flux_list_work', { projectId: f.projectId })), 'reading still works');
  });

  test('a change that waited is refused on Approve when the owner has since set Only read, and nothing is made', async () => {
    await reset();
    await setMayDo('ask');
    await create('Waited, then read-only');
    await setMayDo('read');
    const [waiting] = await rows();
    assert.equal((await decide(owner, waiting!.id, 'apply')).status, 403);
    assert.equal((await titled('Waited, then read-only')).length, 0);
  });

  test('Undo takes back that one change and never the client\'s earlier work', async () => {
    await reset();
    const early = toolValue(await create('Earlier task')).workId as string;
    const later = toolValue(await create('Later task')).workId as string;
    const [first, second] = await rows();
    const undone = expectStatus(await f.owner.request('POST', assistantRunChangesActionPath(second!.id, 'undo'), { body: {} }), 200) as AssistantRunUndone;
    assert.equal(undone.undone, 1);
    const states = Object.fromEntries((await rows()).map((row) => [row.id, row.state]));
    assert.deepEqual([states[first!.id], states[second!.id]], ['applied', 'undone']);
    const listed = (expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/work?limit=50`), 200) as { items: { id: string }[] }).items.map((item) => item.id);
    assert.ok(listed.includes(early), 'the earlier task stays');
    assert.ok(!listed.includes(later), 'the later task is taken back');
  });

  describe('attacks', () => {
    test('the client\'s own token cannot approve, skip or undo: the decisions take a signed-in browser session only', async () => {
      await reset();
      await setMayDo('ask');
      await create('Cannot approve itself');
      const [waiting] = await rows();
      for (const [method, path] of [['POST', assistantChangeActionPath(waiting!.id, 'apply')], ['POST', assistantChangeActionPath(waiting!.id, 'skip')],
        ['POST', assistantRunChangesActionPath(f.connectionId, 'apply')], ['PATCH', agentConnectionPath(f.connectionId)]] as const) {
        const response = await fetch(new URL(path, apiUrl), { method, headers: { authorization: `Bearer ${f.accessToken}`, origin: publicOrigin, 'content-type': 'application/json' },
          body: JSON.stringify(method === 'PATCH' ? { mayDo: 'act' } : {}) });
        assert.ok([401, 403].includes(response.status), `${method} ${path} answered ${response.status}`);
      }
      assert.equal((await rows())[0]!.state, 'waiting');
      assert.equal((await titled('Cannot approve itself')).length, 0);
    });

    test('another person neither sees nor decides the owner\'s waiting change', async () => {
      await reset();
      await setMayDo('ask');
      await create('Not for Jonas');
      const [waiting] = await rows();
      assert.equal((await decide(peer, waiting!.id, 'apply')).status, 404);
      assert.equal((await decide(peer, waiting!.id, 'skip')).status, 404);
      assert.equal((await peer.browser.request('POST', assistantRunChangesActionPath(f.connectionId, 'apply'), { body: {} })).status, 404);
      assert.equal((await titled('Not for Jonas')).length, 0);
      assert.equal((await rows())[0]!.state, 'waiting');
    });

    test('the owner losing access to the space stops Approve: the change is refused and nothing is made', async () => {
      await reset();
      await setMayDo('ask');
      await create('Lost access');
      // The scene's owner is the company's owner, who always reaches every space (#903): this puts them where an added-then-removed member is.
      const restore = await loseSpace(f.projectId, owner.id);
      try {
        const [waiting] = await rows();
        const answer = await decide(owner, waiting!.id, 'apply');
        assert.ok([403, 404, 409].includes(answer.status), `Approve answered ${answer.status}`);
        assert.notEqual((await rows())[0]!.state, 'applied_after_wait');
        assert.equal((await titled('Lost access')).length, 0);
      } finally { await restore(); }
    });

    test('Disconnect: the token stops at once and a change that waited can no longer be approved', async () => {
      const scene = await actionScene(pool);
      const meResponse = expectStatus(await scene.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
      const solo: Person = { id: meResponse.user.id, email: '', browser: scene.owner };
      expectStatus(await scene.owner.request('PATCH', agentConnectionPath(scene.connectionId), { body: { mayDo: 'ask' } }), 200);
      const answer = await scene.tool('flux_create_task', { projectId: scene.projectId, clientCommandId: randomUUID(), task: { title: 'Disconnected' } });
      assert.match(text(answer), /^Waiting for /);
      const waitingItems = async () => (expectStatus(await scene.owner.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.filter((item) => item.key.startsWith('assistant:'));
      assert.equal((await waitingItems()).length, 1, 'the owner is told one thing waits');
      expectStatus(await scene.owner.request('DELETE', agentConnectionPath(scene.connectionId)), 204);
      const [waiting] = (await pool.query(`SELECT id, state, wait_reason, refusal FROM assistant_changes WHERE connection_id = $1`, [scene.connectionId])).rows as
        { id: string; state: string; wait_reason: string | null; refusal: string | null }[];
      assert.deepEqual([waiting!.state, waiting!.wait_reason, waiting!.refusal], ['refused', null, 'Disconnected before you decided'], 'Disconnect closed what waited in the same step');
      assert.equal((await waitingItems()).length, 0, 'no dead item stays in the Inbox');
      assert.ok([403, 404, 409].includes((await decide(solo, waiting!.id, 'apply')).status));
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'Disconnected'`)).rows[0].n), 0);
      assert.notEqual((await scene.raw('flux_list_work', { projectId: scene.projectId })).status, 200, 'the revoked connection is refused before any tool');
    });

    test('a client cannot change a thing in a space it was not asked into, or of another space\'s object', async () => {
      await reset();
      const other = await actionScene(pool);
      const foreign = expectStatus(await other.owner.request('POST', `/api/v1/projects/${other.projectId}/work`, { body: { title: 'Elsewhere' } }), 201) as { id: string; version: number };
      const answer = await f.tool('flux_update_task', { projectId: f.projectId, clientCommandId: randomUUID(), workId: foreign.id, expectedVersion: foreign.version, changes: { title: 'Hijacked' } });
      assert.equal((answer?.result as { isError?: boolean }).isError, true);
      assert.equal(((await pool.query(`SELECT title FROM project_work_items WHERE id = $1`, [foreign.id])).rows[0] as { title: string }).title, 'Elsewhere');
      assert.equal((await rows()).filter((row) => row.state !== 'refused').length, 0, 'nothing waits or applies for an object of another space');
    });

    test('a client edit of the waiting text is not possible: Edit takes a signed-in session and only a waiting new task', async () => {
      await reset();
      await setMayDo('ask');
      await create('Edit me not');
      const [waiting] = await rows();
      const response = await fetch(new URL(assistantChangeActionPath(waiting!.id, 'edit'), apiUrl), { method: 'POST',
        headers: { authorization: `Bearer ${f.accessToken}`, origin: publicOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, title: 'Different' }) });
      assert.ok([401, 403].includes(response.status));
    });
  });
});

// Co-work for another person (C-18, #859): a child unit given to another person's client and a request to it are another person's things,
// like a task for someone else, so they wait for the sender's owner. Taking a task and giving a unit to one's own other client do not.
describe('co-work for another person\'s client waits for the owner\'s OK', () => {
  let jonas: Awaited<ReturnType<typeof agentConnection>>;
  let ownSecond: Awaited<ReturnType<typeof agentConnection>>;
  let task: { id: string; version: number };
  let material: string;
  before(async () => {
    const make = async (who: Person, name: string) => (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
    jonas = await agentConnection(pool, peer.browser, await make(peer, 'Jonas Codex'), [f.projectId]);
    ownSecond = await agentConnection(pool, f.owner, await make(owner, 'Second client'), [f.projectId]);
    task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Shared outcome' } }), 201) as { id: string; version: number };
    material = String((expectStatus(await owner.browser.request('POST', `/api/v1/projects/${f.projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Review criteria', body: 'Exact revision' } }), 201) as { materialId: string }).materialId);
  });
  const base = (who: { runtimeSessionId: string }, role: string, clientCommandId: string = randomUUID()) =>
    ({ projectId: f.projectId, runtimeSessionId: who.runtimeSessionId, clientCommandId, peerRequestClass: role });
  const unitsOf = async (connectionId: string) => (await pool.query(`SELECT id, state, version FROM cowork_units WHERE assignment_connection_id = $1`, [connectionId])).rows as
    { id: string; state: string; version: number }[];
  const requests = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM cowork_requests WHERE work_id = $1`, [task.id])).rows[0].n);
  const waitingOf = async (operation: string) => (await rows()).filter((row) => row.operation === operation);
  let root: { unitId: string; version: number }; let claim: { generation: number; version: number; lease: { id: string } };
  const parent = () => ({ unitId: root.unitId, generation: claim.generation, leaseId: claim.lease.id });
  const give = (to: { connectionId: string }, key: string, clientCommandId?: string) => f.tool('flux_create_unit', { ...base(f, 'review', clientCommandId),
    taskId: task.id, unitKey: key, expectedTaskVersion: task.version, assignmentConnectionId: to.connectionId, parent: parent() });

  test('taking a task and a unit for one\'s own other client do not wait; a unit for Jonas\'s client does', async () => {
    await reset();
    root = toolValue(await f.tool('flux_create_unit', { ...base(f, 'execute'), taskId: task.id, unitKey: 'take', expectedTaskVersion: task.version,
      assignmentConnectionId: f.connectionId, parent: null })) as typeof root;
    claim = toolValue(await f.tool('flux_claim_unit', { ...base(f, 'execute'), unitId: root.unitId, expectedVersion: root.version })) as typeof claim;
    assert.equal((await rows()).length, 0, 'taking and claiming a task leave no change to decide');
    const mine = toolValue(await give(ownSecond, 'own-helper')) as { unitId: string };
    assert.ok(mine.unitId, 'a unit for the owner\'s own other client is made at once');
    assert.equal((await rows()).length, 0);
    const answer = await give(jonas, 'review-1');
    assert.match(text(answer), /^Waiting for /);
    assert.equal((await unitsOf(jonas.connectionId)).length, 0, 'nothing is given to Jonas\'s client yet');
    const [waiting] = await waitingOf('cowork.unit.create');
    assert.deepEqual([waiting!.state, waiting!.wait_reason], ['waiting', 'others']);
    assert.equal((await inbox()).length, 1, 'one item in the owner\'s Inbox');
    assert.equal((await peer.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} })).status, 404, 'Jonas cannot approve it');
  });

  test('Approve gives the unit to Jonas\'s client, once; the client\'s retry says it was made', async () => {
    const [waiting] = await waitingOf('cowork.unit.create');
    expectStatus(await decide(owner, waiting!.id, 'apply'), 200);
    const given = await unitsOf(jonas.connectionId);
    assert.equal(given.length, 1);
    assert.equal(given[0]!.state, 'pending');
    assert.equal((await waitingOf('cowork.unit.create'))[0]!.state, 'applied_after_wait');
    assert.match(text(await give(jonas, 'review-1', waiting!.client_command_id)), /approved this change and it was made/);
    assert.equal((await unitsOf(jonas.connectionId)).length, 1, 'a retry makes no second unit');
  });

  test('a request to Jonas\'s client waits; Skip sends nothing; Approve queues it once', async () => {
    const unit = (await unitsOf(jonas.connectionId))[0]!;
    const send = (key: string, clientCommandId?: string) => {
      const target = { type: 'work', id: task.id, version: task.version };
      return f.tool('flux_send_request', { ...base(f, 'execute', clientCommandId), unitId: root.unitId, generation: claim.generation, leaseId: claim.lease.id,
        recipientUnitId: unit.id, expectedRecipientUnitVersion: unit.version, recipientConnectionId: jonas.connectionId, intentKey: key, parentRequestId: null,
        kind: 'review', target, sourceRefs: [{ type: 'material', id: material, version: 1 }], criteriaRefs: [target], peerUnblocking: true });
    };
    assert.match(text(await send('ask-1')), /^Waiting for /);
    assert.equal(await requests(), 0, 'nothing reaches Jonas\'s client yet');
    const first = (await waitingOf('cowork.request'))[0]!;
    assert.equal(first.wait_reason, 'others');
    expectStatus(await decide(owner, first.id, 'skip'), 200);
    assert.equal(await requests(), 0, 'Skip sends nothing');
    assert.match(text(await send('ask-2')), /^Waiting for /);
    const second = (await waitingOf('cowork.request')).find((row) => row.state === 'waiting')!;
    expectStatus(await decide(owner, second.id, 'apply'), 200);
    assert.equal(await requests(), 1);
    assert.equal(((await pool.query(`SELECT state, sender_connection_id FROM cowork_requests WHERE work_id = $1`, [task.id])).rows[0] as { state: string; sender_connection_id: string }).sender_connection_id, f.connectionId);
    expectStatus(await decide(owner, second.id, 'apply'), 409);
    assert.equal(await requests(), 1, 'a second Approve queues nothing more');
  });

  test('Only read refuses both, and nothing waits', async () => {
    await pool.query(`DELETE FROM assistant_changes WHERE connection_id = $1`, [f.connectionId]);
    await setMayDo('read');
    try {
      const refused = await give(jonas, 'review-read');
      assert.equal((refused?.result as { isError?: boolean }).isError, true);
      assert.equal((await rows()).filter((row) => row.state === 'waiting').length, 0);
    } finally { await setMayDo('act'); }
  });

  test('Approve fails safe when the sender\'s claim has ended: nothing is given and the change closes', async () => {
    await pool.query(`DELETE FROM assistant_changes WHERE connection_id = $1`, [f.connectionId]);
    assert.match(text(await give(jonas, 'review-late')), /^Waiting for /);
    const [waiting] = await waitingOf('cowork.unit.create');
    const before = (await unitsOf(jonas.connectionId)).length;
    await pool.query(`UPDATE cowork_units SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [root.unitId]);
    const answer = expectStatus(await decide(owner, waiting!.id, 'apply'), 403) as { error?: string };
    assert.match(String(answer.error), /The claim this was made under has ended, so it can't be made now\. Ask again with a live claim/, 'the owner is told why, in plain words');
    assert.equal((await waitingOf('cowork.unit.create'))[0]!.state, 'refused');
    assert.match(String((await waitingOf('cowork.unit.create'))[0]!.refusal), /claim this was made under has ended/, 'and the change line says it too');
    assert.equal((await unitsOf(jonas.connectionId)).length, before, 'no unit was given on a claim that had ended');
  });
});
