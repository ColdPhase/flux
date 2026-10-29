import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { CROSS_WORKSPACE_READ_ROUTES, LOCKED_ALLOWED_ROUTES } from '@flux/contracts';
import { sealFor, type Database, type ProcessKeys } from '@flux/core';
import { loadActor, lockedReadScope, sql, workspaceEncryptionRows, type DbExecutor, type SQL } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';

/**
 * The S1 lock gate of encrypted workspaces (F-030, #655): until S2a seals every repository through `sealFor`, any route
 * that names an object of a sealed workspace by a known parameter (or a `workspaceId`/`projectId` in a command body)
 * answers `423 WORKSPACE_LOCKED` while that workspace is locked here, unless it is a metadata route in
 * `LOCKED_ALLOWED_ROUTES`. Fail closed: the check is `sealFor` itself, so a stale boot, a missing version row, unsafe
 * swap or an unreachable keyring all read as locked. Only a member learns it; anyone else gets the route's own answer.
 * A plain workspace costs one indexed lookup.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAMS: [string, (id: string) => SQL][] = [
  ['workspaceId', (id) => sql`SELECT ${id}::uuid AS id`],
  ['workspace', (id) => sql`SELECT ${id}::uuid AS id`],
  ['projectId', (id) => sql`SELECT workspace_id AS id FROM projects WHERE id = ${id}`],
  ['conversationId', (id) => sql`SELECT workspace_id AS id FROM project_conversations WHERE id = ${id}`],
  ['workId', (id) => sql`SELECT workspace_id AS id FROM project_work_items WHERE id = ${id}`],
  ['taskId', (id) => sql`SELECT workspace_id AS id FROM project_work_items WHERE id = ${id}`],
  ['decisionId', (id) => sql`SELECT workspace_id AS id FROM project_decisions WHERE id = ${id}`],
  ['draftId', (id) => sql`SELECT workspace_id AS id FROM drafts WHERE id = ${id}`],
  ['dmId', (id) => sql`SELECT workspace_id AS id FROM dms WHERE id = ${id}`],
  ['sketchId', (id) => sql`SELECT workspace_id AS id FROM sketches WHERE id = ${id}`],
  ['materialId', (id) => sql`SELECT workspace_id AS id FROM project_materials WHERE id = ${id}`],
  ['docId', (id) => sql`SELECT workspace_id AS id FROM project_materials WHERE id = ${id}`],
  ['fileId', (id) => sql`SELECT workspace_id AS id FROM project_files WHERE id = ${id}`],
  ['resultId', (id) => sql`SELECT workspace_id AS id FROM project_results WHERE id = ${id}`],
];
/** Routes whose generic `:id` names one kind of object. */
const ID_ROUTES: Record<string, (id: string) => SQL> = {
  '/api/v1/inbox/:id': (id) => sql`SELECT workspace_id AS id FROM notifications WHERE id = ${id}`,
  '/api/v1/inbox/:id/read': (id) => sql`SELECT workspace_id AS id FROM notifications WHERE id = ${id}`,
};
const BODY = ['workspaceId', 'projectId'];

function scopeOf(request: FastifyRequest, url: string): SQL | null {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const byId = ID_ROUTES[url];
  if (byId && typeof params.id === 'string' && UUID.test(params.id)) return byId(params.id);
  for (const [name, query] of PARAMS) {
    const value = params[name];
    if (typeof value === 'string' && UUID.test(value)) return query(value);
  }
  if (request.method === 'GET' || !request.body || typeof request.body !== 'object') return null;
  const body = request.body as Record<string, unknown>;
  for (const name of BODY) {
    const value = body[name];
    if (typeof value === 'string' && UUID.test(value)) return PARAMS.find(([param]) => param === name)![1](value);
  }
  return null;
}

export function lockedRouteKey(method: string, url: string) {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

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
      const store = { skipped: new Set<string>() };
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
      const lockedIds = new Set(locked.map((workspace) => workspace.id));
      const projects = new Set(((await db.execute(sql`SELECT id FROM projects WHERE workspace_id = ANY(${`{${[...lockedIds].join(',')}}`}::uuid[])`)).rows as { id: string }[])
        .map((row) => row.id));
      const ofLocked = (item: unknown) => {
        const value = (item ?? {}) as { workspaceId?: unknown; projectId?: unknown; source?: { workspaceId?: unknown; projectId?: unknown }; project?: { id?: unknown } | null };
        return lockedIds.has(String(value.workspaceId ?? value.source?.workspaceId ?? ''))
          || projects.has(String(value.projectId ?? value.source?.projectId ?? value.project?.id ?? ''));
      };
      const answer = { ...(payload as Record<string, unknown>) };
      for (const key of ['items', 'results'] as const) if (Array.isArray(answer[key])) answer[key] = (answer[key] as unknown[]).filter((item) => !ofLocked(item));
      return { ...answer, lockedWorkspaces: locked };
    }, ...preSerialization] as RouteOptions['preSerialization'];
  }
  async function refuseWhileLocked(request: FastifyRequest, url: string) {
    const scope = scopeOf(request, url);
    if (!scope) return;
    const result = await db.execute(sql`SELECT w.id, w.encrypted FROM workspaces w WHERE w.id = (${scope} LIMIT 1)`);
    const row = result.rows[0] as { id: string; encrypted: boolean } | undefined;
    if (!row?.encrypted) return;
    const session = await sessions.resolveSession(request.headers);
    if (!session || !(await loadActor(session.principal, row.id, db)).active) return;
    await sealFor(workspaceEncryptionRows(db as unknown as DbExecutor), keys, row.id, { write: false });
  }
  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.url.startsWith('/api/v1/')) return;
    const methods = [route.method].flat();
    if (methods.every((method) => LOCKED_ALLOWED_ROUTES[lockedRouteKey(method, route.url)] !== undefined)) return;
    if (methods.some((method) => CROSS_WORKSPACE_READ_ROUTES.includes(lockedRouteKey(method, route.url)))) crossWorkspace(route);
    const existing = route.preValidation ? [route.preValidation].flat() : [];
    route.preValidation = [async (request: FastifyRequest) => {
      const key = lockedRouteKey(request.method, route.url);
      if (LOCKED_ALLOWED_ROUTES[key] !== undefined) return;
      if (!CROSS_WORKSPACE_READ_ROUTES.includes(key)) await refuseWhileLocked(request, route.url);
    }, ...existing];
  });
}
