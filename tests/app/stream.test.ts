import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Draft, Workspace } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { Browser } from './support/http.js';
import { addMember, draft, expectStatus, grant, person, project, removeMember, secondSession, share, workspace, type Person } from './support/people.js';
import { StreamClient, upgradeStatus } from './support/stream.js';

// WebSocket stream: replay, live delivery and per-recipient policy (issue #29, AC-3).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const heartbeatMs = Number(process.env.FLUX_STREAM_HEARTBEAT_MS ?? 25_000);

async function head(someone: Person) {
  const client = await StreamClient.connect(someone.browser);
  const { cursor } = await client.ready();
  await client.close();
  return cursor;
}

/** Connects with a cursor and returns every event replayed before `ready`. */
async function replay(someone: Person, cursor: number) {
  const client = await StreamClient.connect(someone.browser, { cursor });
  await client.ready();
  const events = [...client.events];
  await client.close();
  return events;
}

describe('event stream', () => {
  let alice: Person; // owner of the shared workspace
  let bob: Person; // member there, owner of his own workspace
  let carol: Person; // member without restricted-project grants
  let shared: Workspace;
  let bobsOwn: Workspace;

  before(async () => {
    [alice, bob, carol] = await Promise.all(['stream-alice', 'stream-bob', 'stream-carol'].map(person));
    shared = await workspace(alice, 'Stream shared');
    bobsOwn = await workspace(bob, 'Bob only');
    await addMember(alice, shared.id, bob, 'member');
    await addMember(alice, shared.id, carol, 'member');
  });

  test('replay after a cursor delivers only events the recipient may see', async () => {
    const start = await head(alice);
    const bobPrivate = await draft(bob, shared.id, 'Bob private notes');
    const room = await project(alice, shared.id, 'Restricted room', 'restricted');
    await grant(alice, room.id, bob, 'contributor');
    const roomDraft = await share(alice, await draft(alice, shared.id, 'Room plan', { projectId: room.id }), 'project');
    const elsewhere = await share(bob, await draft(bob, bobsOwn.id, 'Other tenant'), 'workspace');
    const wide = await share(alice, await draft(alice, shared.id, 'All hands'), 'workspace');

    const forAlice = await replay(alice, start);
    const aliceObjects = new Set(forAlice.map((e) => e.objectId));
    assert.ok(forAlice.some((e) => e.kind === 'project.created.v1' && e.objectId === room.id), 'restricted project visible to its owner');
    assert.ok(forAlice.some((e) => e.kind === 'draft.shared.v1' && e.objectId === roomDraft.id));
    assert.ok(forAlice.some((e) => e.kind === 'draft.shared.v1' && e.objectId === wide.id));
    assert.equal(aliceObjects.has(bobPrivate.id), false, 'a private draft of another member never reaches the workspace owner');
    assert.equal(aliceObjects.has(elsewhere.id) || aliceObjects.has(bobsOwn.id), false, 'another workspace never reaches a non-member');
    assert.ok(forAlice.every((e) => e.workspaceId === shared.id), 'alice only belongs to the shared workspace');
    for (let i = 1; i < forAlice.length; i += 1) assert.ok(forAlice[i]!.seq > forAlice[i - 1]!.seq, 'replay is in seq order');
    for (const event of forAlice) assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'id', 'kind', 'objectId', 'objectType', 'seq', 'type', 'workspaceId'], 'identifiers and kind only');

    const forCarol = await replay(carol, start);
    const carolObjects = new Set(forCarol.map((e) => e.objectId));
    assert.equal(carolObjects.has(room.id), false, 'restricted project events skip non-grantees');
    assert.equal(carolObjects.has(roomDraft.id), false, 'restricted project drafts skip non-grantees');
    assert.equal(carolObjects.has(bobPrivate.id), false);
    assert.ok(carolObjects.has(wide.id), 'workspace-wide draft reaches every member');

    const forBob = await replay(bob, start);
    const bobObjects = new Set(forBob.map((e) => e.objectId));
    assert.ok(bobObjects.has(bobPrivate.id) && bobObjects.has(roomDraft.id) && bobObjects.has(elsewhere.id), 'bob sees his own drafts and his grants');

    // An event id is also a cursor, but only for an event the caller may receive.
    const shareEvent = forAlice.find((e) => e.objectId === wide.id && e.kind === 'draft.shared.v1')!;
    const fromId = await StreamClient.connect(alice.browser, { cursor: shareEvent.id });
    const ready = await fromId.ready();
    assert.ok(ready.cursor >= shareEvent.seq);
    assert.equal(fromId.events.some((e) => e.seq <= shareEvent.seq), false);
    await fromId.close();
    const hiddenEvent = forBob.find((e) => e.objectId === bobPrivate.id)!;
    assert.equal(await upgradeStatus(alice.browser, { cursor: hiddenEvent.id }), 400, 'an invisible event id is not a usable cursor');
  });

  test('live delivery follows replay and still filters per recipient', async () => {
    const aliceStream = await StreamClient.connect(alice.browser);
    const carolStream = await StreamClient.connect(carol.browser);
    await Promise.all([aliceStream.ready(), carolStream.ready()]);
    const hidden = await draft(bob, shared.id, 'Bob live private');
    const visible = await share(bob, await draft(bob, shared.id, 'Bob live shared'), 'workspace');
    const live = await aliceStream.event(visible.id, 'draft.shared.v1');
    assert.equal(live.workspaceId, shared.id);
    assert.equal(live.objectType, 'draft');
    await carolStream.event(visible.id, 'draft.shared.v1');
    // Events arrive in seq order, so a delivered private event would already be here.
    assert.equal(aliceStream.events.some((e) => e.objectId === hidden.id), false);
    assert.equal(carolStream.events.some((e) => e.objectId === hidden.id), false);
    await Promise.all([aliceStream.close(), carolStream.close()]);
  });

  test('after membership removal the next events are not delivered', async () => {
    const team = await workspace(alice, 'Stream removal');
    await addMember(alice, team.id, carol, 'member');
    const carolsOwn = await workspace(carol, 'Carol only');
    const stream = await StreamClient.connect(carol.browser);
    await stream.ready();
    const before = await share(alice, await draft(alice, team.id, 'Before removal'), 'workspace');
    await stream.event(before.id, 'draft.shared.v1');

    await removeMember(alice, team.id, carol);
    const afterRemoval = await share(alice, await draft(alice, team.id, 'After removal'), 'workspace');
    const sentinel = await draft(carol, carolsOwn.id, 'Sentinel');
    await stream.event(sentinel.id, 'draft.created.v1');
    assert.equal(stream.events.some((e) => e.objectId === afterRemoval.id), false, 'no event after the removal');
    assert.equal(stream.events.some((e) => e.kind === 'workspace.member_removed.v1'), false, 'the removal itself is past her access');
    assert.equal(stream.closeCode, null, 'the stream stays open for her other workspaces');
    await stream.close();
  });

  test('a revoked session closes the stream and cannot reconnect', async () => {
    const other = await secondSession(carol);
    const carolsOwn = await workspace(carol, 'Carol revocation');
    const stream = await StreamClient.connect(other.browser);
    await stream.ready();
    expectStatus(await carol.browser.request('DELETE', `/api/v1/sessions/${other.sessionId}`), 204);
    const next = await draft(carol, carolsOwn.id, 'After revocation');
    const closed = await Promise.race([stream.closed, new Promise<null>((resolve) => setTimeout(() => resolve(null), heartbeatMs * 3 + 5000))]);
    assert.ok(closed, 'the stream closed');
    assert.equal(closed.code, 4401);
    assert.equal(stream.events.some((e) => e.objectId === next.id), false, 'nothing delivered after revocation');
    assert.equal(await upgradeStatus(other.browser), 401, 'reconnect with the revoked session');
  });

  test('upgrades need the public origin, a live session and a valid cursor', async () => {
    assert.equal(await upgradeStatus(alice.browser, { origin: 'https://evil.example' }), 403, 'foreign origin');
    assert.equal(await upgradeStatus(alice.browser, { origin: null }), 403, 'missing origin');
    assert.equal(await upgradeStatus(new Browser()), 401, 'no session');
    assert.equal(await upgradeStatus(alice.browser, { cursor: 'not-a-cursor' }), 400);
    assert.equal(await upgradeStatus(alice.browser, { cursor: 999_999_999_999 }), 400, 'cursor ahead of the log');
    assert.equal(await upgradeStatus(alice.browser), 101);
  });

  test('the server pings on the heartbeat interval', async () => {
    const stream = await StreamClient.connect(alice.browser);
    await stream.until(() => stream.pings >= 2, heartbeatMs * 3 + 2000, 'two pings');
    assert.equal(stream.closeCode, null, 'a client that answers pings stays connected');
    await stream.close();
  });

  test('stored events carry a monotonic seq assigned in commit order', async () => {
    const result = await pool.query('SELECT count(*)::int AS missing FROM events WHERE seq IS NULL');
    assert.equal(result.rows[0].missing, 0);
    const item: Draft = await draft(alice, shared.id, 'Seq check');
    const rows = await pool.query("SELECT seq FROM events WHERE object_id = $1 AND kind = 'draft.created.v1'", [item.id]);
    assert.equal(rows.rowCount, 1);
    const later = await pool.query('SELECT max(seq)::bigint AS max FROM events');
    assert.ok(Number(later.rows[0].max) >= Number(rows.rows[0].seq));
  });
});
