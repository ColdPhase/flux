import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { LiveMedia } from '@flux/core';
import { livePresentPath, type LiveSession, type WorkItem } from '@flux/contracts';
import { liveRoutes } from '../../apps/server/src/live/routes.js';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { discoverLiveSessions } from '../../apps/server/src/live/discovery.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';

// #238 AC-U2/AC-U4: a live session anchored on a task, and a presentation of it, are persisted uses under the shared
// task fence; discovery is only a read. After Undo, the task is no live anchor or presented object at all. Real live
// routes, store, policy and SQL; the media server is the same in-process stand-in the other live tests use.
test('live discovery reads leave Undo available, a started session is a first use, and an undone task is no live anchor', { timeout: 30_000 }, async () => {
  const f = await actionScene(pool);
  const create = await f.grant('work.create', 'execute', 5);
  const native = async (title: string) => {
    const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: create.id,
      clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title } }));
    return await f.read(String(created.workId)) as unknown as WorkItem;
  };
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const rooms = new Set<string>();
  const media: LiveMedia = {
    async ensureRoom(roomId) { rooms.add(roomId); },
    async requireRoom(roomId) { assert.ok(rooms.has(roomId)); },
    async grant(roomId) { return { token: `jwt:${roomId}`, expiresAt: new Date(Date.now() + 90_000) }; },
    async participants() { return []; },
    async occupancy() { return 0; },
    async removeAdmissions() {},
    async deleteRoom(roomId) { rooms.delete(roomId); },
  };
  const app = Fastify();
  await app.register(liveRoutes, {
    sessions: { requirePrincipal: async () => ({ principal: { kind: 'human', id: ownerId }, sessionId: `auth-${ownerId}` }) } as never,
    ports: { access: liveAccess(db), sessions: liveSessionStore(db), media, mediaUrl: 'wss://media.example.test' },
  });
  const start = (id: string) => app.inject({ method: 'POST', url: '/api/v1/live-sessions', payload: { context: { type: 'work', id }, clientSessionId: randomUUID() } });
  const undo = (item: WorkItem) => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
  const use = async (id: string) => (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [id])).rows[0].first_persisted_use_at as Date | null;
  try {
    // Discovery is an observation: no use.
    const anchored = await native('Measure under the shared lamp');
    await discoverLiveSessions(db, media, { kind: 'human', id: ownerId }, f.projectId);
    assert.equal(await use(anchored.id), null);
    assert.deepEqual((await f.read(anchored.id) as unknown as WorkItem).creationUndo, { eligible: true, reason: 'eligible' });
    // A started session on the task is its first use; Undo is then refused and changes nothing.
    const started = await start(anchored.id);
    assert.equal(started.statusCode, 201, started.body);
    assert.deepEqual((started.json() as LiveSession).context, { type: 'work', id: anchored.id });
    assert.ok(await use(anchored.id));
    const current = await f.read(anchored.id) as unknown as WorkItem;
    assert.deepEqual(current.creationUndo, { eligible: false, reason: 'task_used' });
    const refused = await undo(current);
    assert.equal(refused.status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [anchored.id])).rows[0].n, 0);

    // After Undo the task is not a live anchor: no session, no room, no use.
    const history = await native('Calibrate before anyone joins');
    expect(await undo(history), 200);
    const roomsBefore = rooms.size;
    const denied = await start(history.id);
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal((denied.json() as { code: string }).code, 'LIVE_CONTEXT_NOT_FOUND');
    assert.equal(rooms.size, roomsBefore);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM live_sessions WHERE work_id=$1', [history.id])).rows[0].n, 0);
    assert.equal(await use(history.id), null);
    // Nor can it be presented in a session on another, still active anchor.
    const session = started.json() as LiveSession;
    const presented = await app.inject({ method: 'POST', url: livePresentPath(session.id),
      payload: { ref: { type: 'work', id: history.id, version: (await f.read(history.id) as unknown as WorkItem).version }, clientEventId: randomUUID() } });
    assert.equal(presented.statusCode, 404, presented.body);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM live_presentations WHERE ref_type='work' AND ref_id=$1", [history.id])).rows[0].n, 0);
  } finally { await app.close(); }
});
