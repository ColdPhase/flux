import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { LOCKED_ALLOWED_ROUTES } from '@flux/contracts';
import { loadActor, sealFor, type Database, type ProcessKeys } from '@flux/core';
import { sql, workspaceEncryptionRows, type DbExecutor, type SQL } from '@flux/db';
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
];
const BODY = ['workspaceId', 'projectId'];

function scopeOf(request: FastifyRequest): SQL | null {
  const params = (request.params ?? {}) as Record<string, unknown>;
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
  async function refuseWhileLocked(request: FastifyRequest) {
    const scope = scopeOf(request);
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
    const existing = route.preValidation ? [route.preValidation].flat() : [];
    route.preValidation = [async (request: FastifyRequest) => {
      if (LOCKED_ALLOWED_ROUTES[lockedRouteKey(request.method, route.url)] !== undefined) return;
      await refuseWhileLocked(request);
    }, ...existing];
  });
}
