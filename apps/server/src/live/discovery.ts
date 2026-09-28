import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { LiveContextRef, LiveSession } from '@flux/contracts';
import { schema } from '@flux/db';
import { DomainError, InvalidInputError, NotFoundError, type Database, type LiveMedia, type Principal } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { liveAccess, requireLiveContext } from './access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 50;
const MAX_SCAN = 500;
type Row = typeof schema.liveSessions.$inferSelect;

function anchor(row: Row): LiveContextRef {
  if (row.conversationId) return { type: 'conversation', id: row.conversationId };
  if (row.workId) return { type: 'work', id: row.workId };
  return { type: 'sketch', id: row.sketchId! };
}

function limitOf(value: unknown): number {
  const limit = value === undefined ? 20 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new InvalidInputError('limit must be an integer from 1 to 20');
  return limit;
}

export interface LiveDiscoveryPage {
  items: LiveSession[];
  /** The last visible session; never a hidden row or a room identifier. */
  nextBefore: string | null;
}

/**
 * Lists active sessions for one currently readable project. Each anchor is checked again:
 * a sketch may have become private since the session started. A cursor must itself still be
 * visible, so it cannot reveal the position or identity of a hidden session.
 */
export async function discoverLiveSessions(
  db: Database, media: Pick<LiveMedia, 'participants'>, principal: Principal,
  projectId: string, query: { limit?: number; before?: string } = {},
): Promise<LiveDiscoveryPage> {
  if (!UUID.test(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  const limit = limitOf(query.limit);
  await liveAccess(db).requireProject(principal, projectId);
  const sessions = schema.liveSessions;
  let before: { id: string; createdAt: Date } | null = null;
  if (query.before !== undefined) {
    if (!UUID.test(query.before)) throw new InvalidInputError('before must be a session UUID');
    const [cursor] = await db.select().from(sessions).where(and(
      eq(sessions.id, query.before), eq(sessions.projectId, projectId), eq(sessions.state, 'available'),
    ));
    if (!cursor) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
    await requireLiveContext(principal, anchor(cursor), projectId, db);
    before = { id: cursor.id, createdAt: cursor.createdAt };
  }

  const visible: Row[] = [];
  let scanned = 0;
  let exhausted = false;
  while (visible.length <= limit && scanned < MAX_SCAN) {
    const position = before === null ? undefined : or(
      lt(sessions.createdAt, before.createdAt),
      and(eq(sessions.createdAt, before.createdAt), lt(sessions.id, before.id)),
    );
    const rows = await db.select().from(sessions).where(and(
      eq(sessions.projectId, projectId), eq(sessions.state, 'available'), position,
    )).orderBy(desc(sessions.createdAt), desc(sessions.id)).limit(Math.min(BATCH, MAX_SCAN - scanned));
    if (!rows.length) { exhausted = true; break; }
    scanned += rows.length;
    for (const row of rows) {
      before = { id: row.id, createdAt: row.createdAt };
      try { await requireLiveContext(principal, anchor(row), projectId, db); }
      catch (error) {
        if (error instanceof DomainError && error.status === 404) continue;
        throw error;
      }
      visible.push(row);
      if (visible.length > limit) break;
    }
    if (rows.length < BATCH) { exhausted = true; break; }
  }
  // An incomplete scan must fail visibly, never claim the hidden rows were the end of the list.
  if (!exhausted && visible.length <= limit && scanned >= MAX_SCAN)
    throw new Error('Live session discovery is temporarily unavailable');

  const page = visible.slice(0, limit);
  const items = await Promise.all(page.map(async (row): Promise<LiveSession> => {
    let participants: LiveSession['participants'];
    try { participants = await media.participants(row.roomId); }
    catch { participants = null; }
    return {
      id: row.id, projectId: row.projectId, context: anchor(row), state: 'available',
      generation: row.generation, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
      participants,
    };
  }));
  // SFU reads can wait while a session ends or its anchor changes. Revalidate
  // each returned row after those awaits before disclosing identifiers or presence.
  for (const row of page) {
    const [current] = await db.select().from(sessions).where(and(
      eq(sessions.id, row.id), eq(sessions.projectId, projectId), eq(sessions.state, 'available'),
    ));
    if (!current || current.generation !== row.generation || current.roomId !== row.roomId)
      throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
    await requireLiveContext(principal, anchor(current), projectId, db);
  }
  if (!page.length) await liveAccess(db).requireProject(principal, projectId);
  return { items, nextBefore: visible.length > limit ? page.at(-1)!.id : null };
}

interface Options { db: Database; media: Pick<LiveMedia, 'participants'>; sessions: SessionResolver }

/** Register after the existing live routes with the same configured media adapter. */
export async function liveDiscoveryRoutes(app: FastifyInstance, { db, media, sessions }: Options) {
  useDomainErrors(app);
  app.get<{ Params: { projectId: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/v1/projects/:projectId/live-sessions',
    { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 }, before: { type: 'string' } } } } },
    async (request) => discoverLiveSessions(db, media,
      (await sessions.requirePrincipal(request)).principal, request.params.projectId, request.query),
  );
}
