import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { idempotencyRepository } from '@flux/db';
import { requestHash } from '@flux/core';
import type { WorkItem } from '@flux/contracts';
import { workRoutes } from '../../apps/server/src/work/routes.js';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { UnauthenticatedError, type SessionContext, type SessionResolver } from '../../apps/server/src/identity/session.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

async function cacheFixture() {
  const f = await actionScene(pool); const grant = await f.grant('work.create', 'execute');
  const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId: grant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Actual native cached trial' } }));
  const item = await f.read(String(created.workId)) as unknown as WorkItem;
  const owner = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const body = { title: item.title }; const key = randomUUID(); const url = `/api/v1/projects/${f.projectId}/work`;
  // Only the transport entry is controlled: origin/baseline/creator/history come from actual
  // native MCP execution. Human-only ordinary HTTP creation must remain ineligible.
  await db.transaction(tx => idempotencyRepository(tx).save({ principal: `human:${owner}`, workspaceId: f.workspaceId,
    operation: 'POST /api/v1/projects/:projectId/work', key }, requestHash({ params: { projectId: f.projectId }, query: {}, body, ifMatch: null }),
  { status: 201, body: item, etag: `"${item.version}"` }, 24));
  const selected = barrier<number>(); const release = barrier(); let hold = false;
  const controlled = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return (action: Parameters<typeof db.transaction>[0]) => target.transaction(async tx => {
      const result = await action(tx);
      if (hold && result && typeof result === 'object' && 'replayed' in result && result.replayed === true) {
        selected.resolve(await backendPid(tx)); await bounded(release.promise, 'cached selection release');
      }
      return result;
    });
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  // This transport instance resolves only the already authenticated real browser/session;
  // grant/lifecycle decisions still run through the unchanged production route and SQL policy.
  const resolve: SessionResolver['resolveSession'] = async headers => {
    if (headers.cookie !== f.owner.cookieHeader()) return null;
    const [row] = (await pool.query(`SELECT s.id,s.expires_at,u.id AS user_id,u.name,u.email FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 AND s.expires_at>clock_timestamp() ORDER BY s.created_at DESC LIMIT 1`, [owner])).rows;
    return row ? { sessionId: row.id, expiresAt: row.expires_at, principal: { kind: 'human', id: row.user_id },
      user: { id: row.user_id, name: row.name, email: row.email } } as SessionContext : null;
  };
  const sessions: SessionResolver = { resolveSession: resolve, async requirePrincipal(request) {
    const session = await resolve(request.headers); if (!session) throw new UnauthenticatedError(); return session;
  } };
  const directory = await mkdtemp(join(tmpdir(), 'flux238-cache-')); const app = Fastify();
  await app.register(async child => workRoutes(child, { db: controlled, sessions, storage: await diskFileStorage(directory) }));
  await Promise.resolve(app.ready());
  const replay = async () => app.inject({ method: 'POST', url, payload: body, headers: { cookie: f.owner.cookieHeader(), 'idempotency-key': key } });
  const undo = () => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
  return { f, item, replay, undo, selected, release, hold: () => { hold = true; }, async close() {
    release.resolve(); await app.close(); await rm(directory, { recursive: true, force: true });
  } };
}

test('actual cached route selects first; Undo waits until the retained replay transaction commits', { timeout: 30_000 }, async () => {
  const f = await cacheFixture(); let replay: ReturnType<typeof f.replay> | undefined; let undo: ReturnType<typeof f.undo> | undefined;
  try {
    f.hold(); replay = f.replay(); void replay.catch(() => undefined);
    const pid = await bounded(f.selected.promise, 'cached response selection'); undo = f.undo(); void undo.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); f.release.resolve();
    const response = await bounded(Promise.resolve(replay), 'cached response'); assert.equal(response.statusCode, 201);
    assert.equal(response.json<WorkItem>().id, f.item.id); assert.equal(response.headers['idempotent-replayed'], 'true');
    expect(await bounded(undo, 'waiting Undo'), 200);
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.item.id])).rows[0].first_persisted_use_at, null);
  } finally {
    f.release.resolve(); try { await bounded(Promise.all([replay?.catch(() => undefined), undo?.catch(() => undefined)]), 'race cleanup'); } finally { await f.close(); }
  }
});

test('Undo commits first; actual cached route returns the typed terminal outcome and preserves the original task', { timeout: 30_000 }, async () => {
  const f = await cacheFixture();
  try {
    expect(await f.undo(), 200);
    const response = await bounded(Promise.resolve(f.replay()), 'terminal cached replay');
    assert.equal(response.statusCode, 409); assert.equal(response.json<{ code: string }>().code, 'TASK_CREATION_REVERTED');
    assert.equal((await f.f.read(f.item.id) as unknown as WorkItem).lifecycle?.state, 'creation_reverted');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND title=$2', [f.item.projectId, f.item.title])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [f.item.id])).rows[0].n, 1);
  } finally { await f.close(); }
});
