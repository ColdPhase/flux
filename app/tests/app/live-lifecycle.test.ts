import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, schema } from '@flux/db';
import { DomainError } from '@flux/core';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { liveLifecycle } from '../../apps/server/src/live/lifecycle.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
const noRoom = async () => undefined;
const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

async function fixture(label: string) {
  const owner = await person(`${label}-owner`);
  const ws = await workspace(owner, label);
  const place = await project(owner, ws.id, `${label} project`, 'restricted');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Live lifecycle anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  return { owner, place, anchor: { type: 'conversation' as const, id: thread.id } };
}

test('project and creator session caps serialize concurrent starts while allowing idempotent replay', async () => {
  const { owner, place, anchor } = await fixture('live-cap');
  const others = await Promise.all([person('live-cap-1'), person('live-cap-2'), person('live-cap-3')]);
  for (const other of others) {
    await addMember(owner, place.workspaceId, other, 'member');
    await grant(owner, place.id, other, 'viewer');
  }
  const store = liveSessionStore(db);
  const principal = (id: string) => ({ kind: 'human' as const, id });
  const make = (id: string, key = randomUUID()) => store.createOrGet(principal(id), place.id, anchor, key, noRoom);
  const ownerKeys = [randomUUID(), randomUUID(), randomUUID()];
  const ownerSessions = await Promise.all(ownerKeys.map((key) => make(owner.id, key)));
  assert.deepEqual(await make(owner.id, ownerKeys[0]), ownerSessions[0]);
  await assert.rejects(make(owner.id), failure('LIVE_SESSION_LIMIT'));
  await Promise.all([make(others[0]!.id), make(others[0]!.id), make(others[0]!.id)]);
  await make(others[1]!.id);
  const contenders = await Promise.allSettled([make(others[1]!.id), make(others[2]!.id)]);
  assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(contenders.filter((result) => result.status === 'rejected' && failure('LIVE_SESSION_LIMIT')(result.reason)).length, 1);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.liveSessions).where(eq(schema.liveSessions.projectId, place.id));
  assert.equal(count, 8);
});

test('authoritative occupancy, reconnect grace, durable ending and crash recovery', async () => {
  const { owner, place, anchor } = await fixture('live-expiry');
  const store = liveSessionStore(db);
  const principal = { kind: 'human' as const, id: owner.id };
  const clientSessionId = randomUUID();
  const session = await store.createOrGet(principal, place.id, anchor, clientSessionId, noRoom);
  let clock = new Date('2026-01-01T00:00:00.000Z');
  let people: { userId: string; joinedAt: string }[] = [{ userId: owner.id, joinedAt: clock.toISOString() }];
  let failPresence = false;
  let failDelete = false;
  const deleted: string[] = [];
  const lifecycle = liveLifecycle(db, pool, {
    async occupancy() {
      if (failPresence) throw new Error('SFU unavailable');
      return people.length;
    },
    async deleteRoom(roomId) {
      if (failDelete) throw new Error('SFU unavailable');
      deleted.push(roomId);
    },
  }, () => clock);

  assert.equal(await lifecycle.reconcile(session.id, session.generation + 1), 'stale');
  assert.equal(await lifecycle.reconcile(session.id), 'occupied');
  people = [];
  assert.equal(await lifecycle.reconcile(session.id), 'empty');
  clock = new Date(clock.getTime() + 89_000);
  assert.equal(await lifecycle.reconcile(session.id), 'empty');
  failPresence = true;
  clock = new Date(clock.getTime() + 2_000);
  assert.equal(await lifecycle.reconcile(session.id), 'unknown');
  assert.equal(deleted.length, 0);
  failPresence = false;
  await store.withAdmission(principal, session.id, async () => 'grant issued');
  assert.equal(await lifecycle.reconcile(session.id), 'empty');
  clock = new Date(clock.getTime() + 89_000);
  assert.equal(await lifecycle.reconcile(session.id), 'empty');
  clock = new Date(clock.getTime() + 2_000);
  failDelete = true;
  await assert.rejects(lifecycle.reconcile(session.id), /SFU unavailable/);
  const beforeRecovery = await db.select().from(schema.liveSessions)
    .where(eq(schema.liveSessions.id, session.id));
  assert.equal(beforeRecovery[0]?.state, 'ending');
  await assert.rejects(store.withAdmission(principal, session.id, async () => 'unexpected'), failure('LIVE_SESSION_ENDED'));
  failDelete = false;
  await lifecycle.recoverPending();
  assert.deepEqual(deleted, [session.roomId]);
  assert.equal((await store.find(session.id))?.state, 'ended');
  await assert.rejects(store.createOrGet(principal, place.id, anchor, clientSessionId, noRoom), failure('LIVE_SESSION_ENDED'));
});

test('never-joined session expires after its longer grace and releases a creator slot', async () => {
  const { owner, place, anchor } = await fixture('live-never-joined');
  const store = liveSessionStore(db);
  const principal = { kind: 'human' as const, id: owner.id };
  const sessions = await Promise.all(Array.from({ length: 3 }, () =>
    store.createOrGet(principal, place.id, anchor, randomUUID(), noRoom)));
  await assert.rejects(store.createOrGet(principal, place.id, anchor, randomUUID(), noRoom), failure('LIVE_SESSION_LIMIT'));
  const created = await db.select({ emptySince: schema.liveSessions.emptySince }).from(schema.liveSessions)
    .where(eq(schema.liveSessions.id, sessions[0]!.id));
  const firstEmpty = created[0]!.emptySince!;
  let clock = new Date(firstEmpty.getTime() + 299_000);
  const deleted: string[] = [];
  const lifecycle = liveLifecycle(db, pool, {
    async occupancy() { return 0; },
    async deleteRoom(roomId) { deleted.push(roomId); },
  }, () => clock);
  assert.equal(await lifecycle.reconcile(sessions[0]!.id), 'empty');
  clock = new Date(firstEmpty.getTime() + 301_000);
  assert.equal(await lifecycle.reconcile(sessions[0]!.id), 'ended');
  assert.deepEqual(deleted, [sessions[0]!.roomId]);
  await store.createOrGet(principal, place.id, anchor, randomUUID(), noRoom);
});

test('sweep reaches sessions beyond 32 rooms whose SFU presence stays unknown', async () => {
  const { owner, place, anchor } = await fixture('live-sweep-fairness');
  const principal = { kind: 'human' as const, id: owner.id };
  const seed = await liveSessionStore(db).createOrGet(principal, place.id, anchor, randomUUID(), noRoom);
  const ids = Array.from({ length: 32 }, () => randomUUID());
  // Seed a loaded database beyond one sweep page. The scheduler must remain
  // fair even if older or migrated rows exceed today's admission cap.
  await pool.query(`INSERT INTO live_sessions
    (id, workspace_id, project_id, conversation_id, created_by, client_session_id,
      state, generation, room_id, empty_since, connected_once, created_at, updated_at)
    SELECT extra.id, s.workspace_id, s.project_id, s.conversation_id, s.created_by,
      extra.id, 'available', 1, 'live_' || replace(extra.id::text, '-', ''),
      '2020-01-01'::timestamptz, false, '2020-01-01'::timestamptz, '2020-01-01'::timestamptz
    FROM live_sessions s CROSS JOIN unnest($2::uuid[]) AS extra(id) WHERE s.id = $1`, [seed.id, ids]);
  await pool.query(`UPDATE live_sessions SET empty_since = '2020-01-01',
    created_at = '2020-01-01', updated_at = '2020-01-01' WHERE id = $1`, [seed.id]);
  const rows = await pool.query<{ id: string; room_id: string }>(`SELECT id, room_id FROM live_sessions
    WHERE project_id = $1 AND state = 'available' ORDER BY updated_at, id`, [place.id]);
  assert.equal(rows.rows.length, 33);
  const last = rows.rows.at(-1)!;
  const observed: string[] = [];
  const deleted: string[] = [];
  const lifecycle = liveLifecycle(db, pool, {
    async occupancy(roomId) {
      observed.push(roomId);
      if (roomId !== last.room_id) throw new Error('SFU unavailable');
      return 0;
    },
    async deleteRoom(roomId) { deleted.push(roomId); },
  }, () => new Date('2026-01-01'));
  await lifecycle.sweep();
  assert.equal(observed.includes(last.room_id), false, 'the last row is outside the first page');
  await lifecycle.sweep();
  assert.ok(observed.includes(last.room_id), 'a failed first page cannot starve later rows');
  assert.deepEqual(deleted, [last.room_id]);
});
