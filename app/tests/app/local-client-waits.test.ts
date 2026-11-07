import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  agentConnectionPath, assistantChangeActionPath, assistantRunChangesActionPath, NEEDS_YOU_PATH, type AssistantRunUndone, type NeedsYouResponse,
} from '@flux/contracts';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { toolValue } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';
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
const rows = async () => (await pool.query(`SELECT id, state, wait_reason, authority, operation, run_id, connection_id, decided_by, client_command_id FROM assistant_changes WHERE connection_id = $1 ORDER BY created_at, id`, [f.connectionId])).rows as
  { id: string; state: string; wait_reason: string | null; authority: string | null; operation: string; run_id: string | null; connection_id: string; decided_by: string | null; client_command_id: string }[];
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
    assert.ok(early && later);
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
      await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'denied', $4)
        ON CONFLICT (project_id, user_id) WHERE (user_id IS NOT NULL) DO UPDATE SET role = 'denied'`, [randomUUID(), f.workspaceId, f.projectId, owner.id]);
      try {
        const [waiting] = await rows();
        const answer = await decide(owner, waiting!.id, 'apply');
        assert.ok([403, 404, 409].includes(answer.status), `Approve answered ${answer.status}`);
        assert.notEqual((await rows())[0]!.state, 'applied_after_wait');
        assert.equal((await titled('Lost access')).length, 0);
      } finally { await pool.query(`DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2`, [f.projectId, owner.id]); }
    });

    test('Disconnect: the token stops at once and a change that waited can no longer be approved', async () => {
      const scene = await actionScene(pool);
      const meResponse = expectStatus(await scene.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
      const solo: Person = { id: meResponse.user.id, email: '', browser: scene.owner };
      expectStatus(await scene.owner.request('PATCH', agentConnectionPath(scene.connectionId), { body: { mayDo: 'ask' } }), 200);
      const answer = await scene.tool('flux_create_task', { projectId: scene.projectId, clientCommandId: randomUUID(), task: { title: 'Disconnected' } });
      assert.match(text(answer), /^Waiting for /);
      expectStatus(await scene.owner.request('DELETE', agentConnectionPath(scene.connectionId)), 204);
      const [waiting] = (await pool.query(`SELECT id FROM assistant_changes WHERE connection_id = $1`, [scene.connectionId])).rows as { id: string }[];
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
