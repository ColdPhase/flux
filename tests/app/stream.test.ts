import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Draft, Workspace } from '@flux/contracts';
import { audiencePageQuery, createDatabase, lastAudienceSeqQuery } from '@flux/db';
import { audienceKey, type Principal } from '@flux/core';
import { Browser } from './support/http.js';
import { addMember, draft, expectStatus, grant, person, project, removeMember, secondSession, share, workspace, type Person } from './support/people.js';
import { StreamClient, upgradeStatus } from './support/stream.js';

// WebSocket stream: replay, live delivery and per-recipient policy (issue #29, AC-3).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());
const heartbeatMs = Number(process.env.FLUX_STREAM_HEARTBEAT_MS ?? 25_000);

async function head(someone: Person) {
  const client = await StreamClient.connect(someone.browser);
  const { cursor } = await client.ready();
  await client.close();
  return cursor;
}

/** Connects with a cursor and returns every event replayed before `ready`. */
async function replay(someone: Person, cursor: string) {
  const client = await StreamClient.connect(someone.browser, { cursor });
  await client.ready();
  const events = [...client.events];
  await client.close();
  return events;
}

/** Everything a person observes on a fresh connection and on a resume from `cursor`. */
async function observe(someone: Person, cursor: string) {
  const fresh = await StreamClient.connect(someone.browser);
  const freshReady = await fresh.ready();
  const freshMessages = [...fresh.messages];
  await fresh.close();
  const resumed = await StreamClient.connect(someone.browser, { cursor });
  const resumedReady = await resumed.ready();
  const resumedMessages = [...resumed.messages];
  await resumed.close();
  return { fresh: freshReady.cursor, freshMessages, resumed: resumedReady.cursor, resumedMessages };
}

interface StreamWork { queries: number; rows: number; authorizations: number }

/** Server-side work counters of the caller's last open→ready (test-only endpoint). */
async function lastWork(someone: Person): Promise<StreamWork> {
  const response = await someone.browser.request('GET', '/api/v1/stream/work');
  const { work } = expectStatus(response, 200) as { work: StreamWork | null };
  assert.ok(work, 'the server recorded open→ready work');
  return work;
}

/** Opens `samples` connections (fresh, or resuming `cursor`) and returns the median open→ready time and the work of each. */
async function openToReady(someone: Person, samples: number, cursor?: string) {
  const times: number[] = [];
  const works: StreamWork[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const client = await StreamClient.connect(someone.browser, cursor ? { cursor } : {});
    await client.ready();
    times.push(performance.now() - started);
    await client.close();
    works.push(await lastWork(someone));
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)]!, works };
}

interface PlanNode { 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; 'Relation Name'?: string; 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] }

/** Rows PostgreSQL read in the scan nodes of a stream query (EXPLAIN ANALYZE), on fresh statistics. */
async function examined(query: { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  await pool.query('ANALYZE event_audience, events');
  // Pin the access path to the indexes the stream relies on. Otherwise the planner may pick a
  // sequential or bitmap scan on a small or fast-growing table, and the row count then reflects
  // plan shape (seen as [47, 82] → [1, 2] and [1, 2] → [1, 3]), not work done for hidden events.
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    result = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const plan = (result.rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0]!.Plan;
  let rows = 0;
  const nodes: string[] = [];
  const walk = (node: PlanNode) => {
    // A bitmap index scan lists addresses for the heap scan above it; counting both doubles
    // the same table rows when PostgreSQL switches between index and bitmap plans.
    if (node['Node Type'].includes('Scan') && node['Node Type'] !== 'Bitmap Index Scan') {
      const loops = node['Actual Loops'] ?? 1;
      rows += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
    }
    nodes.push(`${node['Node Type']}${node['Index Name'] ? ` ${node['Index Name']}` : node['Relation Name'] ? ` ${node['Relation Name']}` : ''}`);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return { rows, nodes };
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
    // Cursors are per person, so each recipient starts from its own head cursor.
    const [start, carolStart, bobStart] = await Promise.all([head(alice), head(carol), head(bob)]);
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
    const order = [room.id, roomDraft.id, wide.id].map((id) => forAlice.findIndex((e) => e.objectId === id));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'replay is in commit order');
    for (const event of forAlice) assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'cursor', 'id', 'kind', 'objectId', 'objectType', 'type', 'workspaceId'], 'identifiers, kind and an opaque cursor only');
    assert.equal(new Set(forAlice.map((e) => e.cursor)).size, forAlice.length, 'each event has its own cursor');
    assert.ok(forAlice.every((e) => /^c1\.[A-Za-z0-9_-]+$/.test(e.cursor)), 'cursors are opaque tokens');

    const forCarol = await replay(carol, carolStart);
    const carolObjects = new Set(forCarol.map((e) => e.objectId));
    assert.equal(carolObjects.has(room.id), false, 'restricted project events skip non-grantees');
    assert.equal(carolObjects.has(roomDraft.id), false, 'restricted project drafts skip non-grantees');
    assert.equal(carolObjects.has(bobPrivate.id), false);
    assert.ok(carolObjects.has(wide.id), 'workspace-wide draft reaches every member');

    const forBob = await replay(bob, bobStart);
    const bobObjects = new Set(forBob.map((e) => e.objectId));
    assert.ok(bobObjects.has(bobPrivate.id) && bobObjects.has(roomDraft.id) && bobObjects.has(elsewhere.id), 'bob sees his own drafts and his grants');

    // An event id is also a cursor, but only for an event the caller may receive.
    const shareIndex = forAlice.findIndex((e) => e.objectId === wide.id && e.kind === 'draft.shared.v1');
    const shareEvent = forAlice[shareIndex]!;
    const upToShare = new Set(forAlice.slice(0, shareIndex + 1).map((e) => e.id));
    for (const cursor of [shareEvent.id, shareEvent.cursor]) {
      const resumed = await StreamClient.connect(alice.browser, { cursor });
      const ready = await resumed.ready();
      assert.equal(resumed.events.some((e) => upToShare.has(e.id)), false, 'resume starts after the cursor event');
      assert.equal(ready.cursor, resumed.events.at(-1)?.cursor ?? shareEvent.cursor, 'ready carries the last visible cursor');
      await resumed.close();
    }
    const hiddenEvent = forBob.find((e) => e.objectId === bobPrivate.id)!;
    assert.equal(await upgradeStatus(alice.browser, { cursor: hiddenEvent.id }), 400, 'an invisible event id is not a usable cursor');
    assert.equal(await upgradeStatus(alice.browser, { cursor: hiddenEvent.cursor }), 400, 'a cursor issued to someone else is rejected');
    assert.equal(await upgradeStatus(alice.browser, { cursor: 1 }), 400, 'raw sequence numbers are not cursors');
  });

  test('restricted activity changes nothing an outsider observes on the stream', async () => {
    const room = await project(alice, shared.id, 'Quiet room', 'restricted');
    const countEvents = async () => (await pool.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [shared.id])).rows[0].n as number;
    const baseline = await head(carol);
    const eventsBefore = await countEvents();
    const before = await observe(carol, baseline);
    const live = await StreamClient.connect(carol.browser);
    const liveReady = await live.ready();

    // Restricted and private activity carol cannot see, in her own workspace.
    for (let i = 0; i < 5; i += 1) {
      await share(alice, await draft(alice, shared.id, `Quiet ${i}`, { projectId: room.id }), 'project');
      await draft(bob, shared.id, `Bob quiet ${i}`);
    }
    assert.ok(await countEvents() >= eventsBefore + 15, 'the log demonstrably moved on');

    const afterwards = await observe(carol, baseline);
    assert.equal(before.fresh, baseline);
    assert.equal(afterwards.fresh, before.fresh, 'a fresh connection gets the same cursor');
    assert.equal(afterwards.resumed, before.resumed, 'a resume gets the same cursor');
    assert.deepEqual(afterwards.freshMessages, before.freshMessages, 'identical frames on a fresh connection');
    assert.deepEqual(afterwards.resumedMessages, before.resumedMessages, 'identical frames on a resume');
    assert.equal(liveReady.cursor, baseline);

    // The live connection received nothing for the invisible events; a visible one arrives next.
    const visible = await share(alice, await draft(alice, shared.id, 'Visible after quiet'), 'workspace');
    const next = await live.event(visible.id, 'draft.shared.v1');
    assert.equal(live.messages[0]!.type, 'ready');
    assert.ok(live.events.every((e) => e.objectId === visible.id), 'nothing about the invisible activity was delivered');
    assert.notEqual(next.cursor, baseline);
    await live.close();
  });

  test('opening and replaying do the same work however much hidden activity exists', async () => {
    // Regression for the ready-latency leak: an outsider's open→ready and replay work must
    // not grow with events she cannot see. Deterministic metrics first, timing as a coarse bound.
    const vault = await workspace(alice, 'Hidden volume');
    const dave = await person('stream-dave');
    const erin = await person('stream-erin');
    await addMember(alice, vault.id, dave, 'member');
    await addMember(alice, vault.id, erin, 'member');
    const room = await project(alice, vault.id, 'Vault room', 'restricted');
    const erinKey: Principal = { kind: 'human', id: erin.id };
    const baseline = await head(erin);
    const erinBefore = await openToReady(erin, 7);
    const resumeBefore = await openToReady(erin, 3, baseline);
    const plansBefore = [await examined(lastAudienceSeqQuery(db, audienceKey(erinKey))), await examined(audiencePageQuery(db, audienceKey(erinKey), 0, 200))];
    const daveStart = await head(dave);

    // 500 events erin cannot see: 250 private drafts by dave, and 125 drafts alice creates
    // in the restricted room and shares to it (created + shared = 2 events each).
    const tasks: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < 250; i += 1) tasks.push(() => draft(dave, vault.id, `Dave private ${i}`));
    for (let i = 0; i < 125; i += 1) tasks.push(async () => share(alice, await draft(alice, vault.id, `Vault ${i}`, { projectId: room.id }), 'project'));
    for (let i = 0; i < tasks.length; i += 25) await Promise.all(tasks.slice(i, i + 25).map((task) => task()));
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [vault.id]);
    assert.ok(n >= 500, `the workspace has at least 500 new events (${n})`);

    const erinAfter = await openToReady(erin, 7);
    const resumeAfter = await openToReady(erin, 3, baseline);
    const plansAfter = [await examined(lastAudienceSeqQuery(db, audienceKey(erinKey))), await examined(audiencePageQuery(db, audienceKey(erinKey), 0, 200))];
    console.log(JSON.stringify({ hiddenEvents: n, openToReadyMs: { before: erinBefore.median, after: erinAfter.median }, work: { before: erinBefore.works[0], after: erinAfter.works[0] }, resumeWork: { before: resumeBefore.works[0], after: resumeAfter.works[0] }, rowsExamined: { before: plansBefore.map((p) => p.rows), after: plansAfter.map((p) => p.rows) }, plans: plansAfter.map((p) => p.nodes) }));

    // Deterministic stream work, with no growth in table rows read by PostgreSQL. On a tiny
    // baseline PostgreSQL may scan the table, then choose an index after the hidden inserts;
    // the cheaper after-plan is valid and must not make this privacy check fail.
    for (const work of [...erinBefore.works, ...erinAfter.works]) assert.deepEqual(work, erinBefore.works[0], 'fresh open→ready work is constant');
    for (const work of [...resumeBefore.works, ...resumeAfter.works]) assert.deepEqual(work, resumeBefore.works[0], 'replay work is constant');
    assert.equal(erinBefore.works[0]!.authorizations, 0, 'no authorization of events she cannot see');
    for (let i = 0; i < plansAfter.length; i += 1) {
      assert.ok(plansAfter[i]!.rows <= plansBefore[i]!.rows,
        `rows examined must not grow with hidden events (query ${i}: ${plansBefore[i]!.rows} → ${plansAfter[i]!.rows})`);
    }
    // Coarse wall-clock bound with a generous margin (the leak was 4 ms → 331 ms for 300 events).
    assert.ok(erinAfter.median <= erinBefore.median * 3 + 50, `open→ready ${erinBefore.median.toFixed(1)} ms → ${erinAfter.median.toFixed(1)} ms`);
    assert.equal(await head(erin), baseline, 'and the cursor is unchanged');

    // The events exist and reach their audience: dave replays his own private drafts.
    const forDave = await replay(dave, daveStart);
    assert.equal(forDave.filter((e) => e.kind === 'draft.created.v1').length, 250);
    assert.equal(forDave.some((e) => e.objectId === room.id), false);
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
    assert.equal(await upgradeStatus(alice.browser, { cursor: 999_999_999_999 }), 400, 'numbers are never cursors');
    assert.equal(await upgradeStatus(alice.browser, { cursor: `c1.${'A'.repeat(48)}` }), 400, 'forged cursor');
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
