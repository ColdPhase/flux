import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { CROSS_WORKSPACE_READ_ROUTES } from '@flux/contracts';
import { sealFor, type ProcessKeys } from '@flux/core';
import { lockedReadScope, sql, workspaceEncryptionRows, type DbExecutor, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';

/**
 * Encrypted workspaces while locked (F-030, #655). There is no per-route check any more (S2a-2c-4): every repository
 * seals and opens through `sealFor`, which fails closed with `423 WORKSPACE_LOCKED` for a locked workspace, and the
 * routes that read only metadata are listed with a reason in `LOCKED_ALLOWED_ROUTES`. `tests/app/encryption-locked-routes.test.ts`
 * walks every registered route with a locked workspace's objects (AC-6). What remains here is the cross-workspace reads:
 * they skip a locked workspace and name it in `lockedWorkspaces` instead of failing.
 */
export function lockedRouteKey(method: string, url: string) {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function registerLockGate(app: FastifyInstance, { db, sessions, keys }: { db: Database; sessions: SessionResolver; keys: ProcessKeys }) {
  /**
   * F-030 `lockedWorkspaces` (S2a-2c): a cross-workspace read runs in `lockedReadScope`, so a sealed workspace that is
   * locked here is skipped instead of failing the read, and the answer names every such workspace of the caller.
   */
  async function lockedOf(request: FastifyRequest, skipped: ReadonlySet<string>) {
    const session = await sessions.resolveSession(request.headers);
    if (!session || session.principal.kind !== 'human') return [];
    const sealed = (await db.execute(sql`SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE w.encrypted AND m.user_id = ${session.principal.id} ORDER BY w.name, w.id`)).rows as { id: string; name: string }[];
    const locked: { id: string; name: string }[] = [];
    for (const row of sealed) {
      if (skipped.has(row.id)) { locked.push(row); continue; }
      try { await sealFor(workspaceEncryptionRows(db as unknown as DbExecutor), keys, row.id, { write: false }); }
      catch (error) { if ((error as { code?: unknown }).code === 'WORKSPACE_LOCKED') locked.push(row); else throw error; }
    }
    return locked;
  }
  function crossWorkspace(route: RouteOptions) {
    const scopes = new WeakMap<FastifyRequest, { skipped: Set<string> }>();
    const onRequest = route.onRequest ? [route.onRequest].flat() : [];
    route.onRequest = [(request: FastifyRequest, _reply: unknown, done: () => void) => {
      const store: { skipped: Set<string>; locked?: Map<string, string> } = { skipped: new Set<string>() };
      scopes.set(request, store);
      lockedReadScope.run(store, done);
    }, ...onRequest] as RouteOptions['onRequest'];
    const preSerialization = route.preSerialization ? [route.preSerialization].flat() : [];
    route.preSerialization = [async (request: FastifyRequest, _reply: unknown, payload: unknown) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
      const locked = await lockedOf(request, scopes.get(request)?.skipped ?? new Set());
      if (!locked.length) return payload; // absent when none is locked, so ordinary answers are unchanged
      // Every item of a locked workspace is left out (Inbox rows too, though they are content-free), whichever way the
      // item names its place: its workspace, its source's workspace, its project or its project id.
      // An item belongs to a locked workspace when it names, anywhere (a field, a source, a link), that workspace or
      // one of its projects or DMs (#717 review P2-1: a mention's url is its only trace of the project).
      const lockedIds = [...new Set(locked.map((workspace) => workspace.id))];
      const list = `{${lockedIds.join(',')}}`;
      const places = new Set([...lockedIds, ...((await db.execute(sql`SELECT id FROM projects WHERE workspace_id = ANY(${list}::uuid[])
        UNION ALL SELECT id FROM dms WHERE workspace_id = ANY(${list}::uuid[])`)).rows as { id: string }[]).map((row) => row.id)]);
      const ofLocked = (item: unknown) => {
        // A `security` notice ("…'s encryption keys were changed outside Flux. It stays locked.", a rotation that cannot
        // finish) is content-free by the notification guard and is about the lock itself: it stays readable (S2c).
        const reasonOf = (value: unknown) => (value && typeof value === 'object' ? (value as { reason?: unknown }).reason : undefined);
        if (reasonOf(item) === 'security' || reasonOf((item as { notification?: unknown } | null)?.notification) === 'security') return false;
        const text = JSON.stringify(item ?? null);
        for (const match of text.matchAll(UUIDS)) if (places.has(match[0].toLowerCase())) return true;
        return false;
      };
      const answer = { ...(payload as Record<string, unknown>) };
      for (const key of ['items', 'results'] as const) {
        if (!Array.isArray(answer[key])) continue;
        const kept = (answer[key] as unknown[]).filter((item) => !ofLocked(item));
        // The counts leave the locked workspaces' items out too (#717 review P3-1).
        if (key === 'items' && typeof answer.count === 'number') answer.count = Math.max(0, answer.count - ((answer[key] as unknown[]).length - kept.length));
        answer[key] = kept;
      }
      if (typeof answer.unread === 'number') {
        const session = await sessions.resolveSession(request.headers);
        const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${session?.principal.id ?? ''}
          AND workspace_id = ANY(${list}::uuid[]) AND in_inbox AND read_at IS NULL AND reason <> 'security'`)).rows as { n: number }[];
        answer.unread = Math.max(0, answer.unread - (row?.n ?? 0));
      }
      return { ...answer, lockedWorkspaces: locked };
    }, ...preSerialization] as RouteOptions['preSerialization'];
  }
  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.url.startsWith('/api/v1/')) return;
    const methods = [route.method].flat();
    if (!methods.some((method) => CROSS_WORKSPACE_READ_ROUTES.includes(lockedRouteKey(method, route.url)))) return;
    crossWorkspace(route);
    const existing = route.preValidation ? [route.preValidation].flat() : [];
    route.preValidation = [async (request: FastifyRequest) => {
      if (!CROSS_WORKSPACE_READ_ROUTES.includes(lockedRouteKey(request.method, route.url))) return;
      const store = lockedReadScope.getStore();
      if (store) store.locked = new Map((await lockedOf(request, new Set())).map((workspace) => [workspace.id, workspace.name]));
    }, ...existing];
  });
}
