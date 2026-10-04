import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { LiveCursor, LiveReceipt } from '@flux/contracts';
import * as schema from '../schema.js';
import { docRows } from './docs.js';
import type { DbExecutor } from './push.js';

export class EditingPresenceCapacityError extends Error { readonly code = 'EDITING_PRESENCE_CAPACITY'; }
export const EDITING_CHANNEL = 'flux_editing';
const h = schema.docLiveHeads; const r = schema.docLiveReplicas; const i = schema.liveEditingIntents; const u = schema.docLiveUpdates;
type SavedDoc = NonNullable<Awaited<ReturnType<ReturnType<typeof docRows>['find']>>>;
interface State extends Record<string, unknown> { workspace: string; room: string; generation: string; body: string; sequence: number }
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function receipt(value: Record<string, unknown>): LiveReceipt {
  if (typeof value.workspaceId !== 'string' || typeof value.resourceId !== 'string' || typeof value.generation !== 'string'
    || !Number.isSafeInteger(value.sequence) || typeof value.hash !== 'string' || typeof value.commandId !== 'string'
    || (value.operation !== 'text' && value.operation !== 'save') || typeof value.fingerprint !== 'string' || typeof value.changed !== 'boolean') {
    throw new Error('Invalid persisted live receipt');
  }
  return value as unknown as LiveReceipt;
}
/** Rows only. Current session/resource policy and the input lease precede every call in the composition. */
export function liveEditingRows<Codec extends State>(db: DbExecutor, decodeState: (value: Record<string, unknown>) => Codec) {
  const present = (row: typeof h.$inferSelect) => ({ resourceId: row.docId, workspaceId: row.workspaceId, projectId: row.projectId,
    generation: row.generation, sequence: row.sequence, body: row.body, hash: row.hash,
    savedVersion: row.savedVersion, savedSequence: row.savedSequence, codecState: row.codecState ? decodeState(row.codecState) : null });
  return {
    async peekHead(docId: string) { const [row] = await db.select().from(h).where(eq(h.docId, docId)); return row ? present(row) : null; },
    async lockHead(docId: string) { const [row] = await db.select().from(h).where(eq(h.docId, docId)).for('update'); return row ? present(row) : null; },
    async insertHead(doc: SavedDoc, generation: string, state: Codec) {
      const [row] = await db.insert(h).values({ docId: doc.doc.id, workspaceId: doc.doc.workspaceId, projectId: doc.doc.projectId,
        generation, sequence: 0, body: state.body, hash: hash(state.body), savedVersion: doc.current.version, savedSequence: 0, codecState: state }).returning();
      return present(row!);
    },
    async replaceState(head: { resourceId: string; generation: string }, state: Codec, bodyHash: string) {
      if (state.room !== head.resourceId || state.generation !== head.generation) throw new Error('Codec state has another namespace');
      const changed = await db.update(h).set({ body: state.body, hash: bodyHash, sequence: state.sequence, codecState: state, updatedAt: new Date() })
        .where(and(eq(h.docId, head.resourceId), eq(h.generation, head.generation))).returning({ id: h.docId });
      if (changed.length !== 1) throw new Error('The locked live head disappeared');
    },
    async replica(docId: string, generation: string, replicaId: number) {
      const [row] = await db.select().from(r).where(and(eq(r.docId, docId), eq(r.generation, generation), eq(r.replicaId, replicaId))).for('update');
      return row ?? null;
    },
    async peekReplica(docId: string, generation: string, replicaId: number) {
      const [row] = await db.select().from(r).where(and(eq(r.docId, docId), eq(r.generation, generation), eq(r.replicaId, replicaId)));
      return row ?? null;
    },
    async insertReplica(docId: string, generation: string, replicaId: number, actorId: string | null, instanceId: string, ownerKind: 'human' | 'server') {
      const [row] = await db.insert(r).values({ docId, generation, replicaId, actorId, instanceId, ownerKind,
        expiresAt: sql`clock_timestamp() + interval '30 seconds'` }).returning();
      return { generation, replicaId, instanceId, expiresAt: row!.expiresAt.toISOString() };
    },
    async renewReplica(docId: string, generation: string, replicaId: number, instanceId: string) {
      const [row] = await db.update(r).set({ expiresAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(and(eq(r.docId, docId), eq(r.generation, generation), eq(r.replicaId, replicaId), eq(r.instanceId, instanceId))).returning();
      if (!row) throw new Error('The immutable enrolled instance disappeared');
      return { generation, replicaId, instanceId, expiresAt: row.expiresAt.toISOString() };
    },
    async lockIntent(actorId: string, commandId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'flux.editing.intent:' + actorId + ':' + commandId}, 0))`);
    },
    async intent(actorId: string, commandId: string) {
      const [row] = await db.select().from(i).where(and(eq(i.actorId, actorId), eq(i.commandId, commandId)));
      return row ?? null;
    },
    async insertIntent(intent: { actorId: string; commandId: string; workspaceId: string; kind: 'wiki' | 'map'; resourceId: string;
      generation: string; operation: string; fingerprint: string; byteLength: number; receipt: LiveReceipt }) {
      await db.insert(i).values({ ...intent, receipt: { ...intent.receipt } });
    },
    async appendUpdate(head: { resourceId: string; generation: string; sequence: number }, envelope: { actor: string; uuid: string }, bytes: Uint8Array, fingerprint: string) {
      await db.insert(u).values({ docId: head.resourceId, generation: head.generation, sequence: head.sequence,
        actorId: envelope.actor, commandId: envelope.uuid, fingerprint, bytes: Buffer.from(bytes).toString('base64') });
    },
    async updates(docId: string, generation: string, afterSequence: number, limit: number) {
      const rows = await db.select({ sequence: u.sequence, bytes: sql<Buffer>`decode(${u.bytes}, 'base64')`, commandId: u.commandId,
        actorId: u.actorId, name: schema.authUsers.name, result: i.receipt }).from(u)
        .innerJoin(i, and(eq(i.actorId, u.actorId), eq(i.commandId, u.commandId)))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, u.actorId))
        .where(and(eq(u.docId, docId), eq(u.generation, generation), gt(u.sequence, afterSequence))).orderBy(asc(u.sequence)).limit(limit);
      return rows.map((row) => ({ sequence: row.sequence, bytes: row.bytes, commandId: row.commandId,
        actor: { kind: 'human' as const, id: row.actorId, name: row.name }, hash: receipt(row.result).hash }));
    },
    async setPresence(docId: string, generation: string, identity: { actorId: string; sessionId: string }, connectionId: string, cursor: LiveCursor | null) {
      const p = schema.docLivePresence;
      if (!cursor) { await db.delete(p).where(and(eq(p.connectionId, connectionId), eq(p.actorId, identity.actorId), eq(p.sessionId, identity.sessionId))); return; }
      const [old] = await db.select({ id: p.connectionId }).from(p).where(eq(p.connectionId, connectionId));
      if (!old) {
        // Only initial presence admission takes the global count lock; renewal is room-serialized already.
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('flux.editing.presence.capacity', 0))`);
        await db.delete(p).where(sql`${p.expiresAt} <= clock_timestamp()`);
        const counts = await db.execute<{ total: number; room: number }>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE doc_id=${docId})::int AS room FROM ${p}`);
        if (counts.rows[0]!.total >= 2048 || counts.rows[0]!.room >= 128) throw new EditingPresenceCapacityError('The bounded presence capacity is busy');
      }
      await db.insert(p).values({ connectionId, docId, generation, actorId: identity.actorId, sessionId: identity.sessionId, cursor,
        expiresAt: sql`LEAST(clock_timestamp() + interval '5 seconds', (SELECT expires_at FROM auth_sessions WHERE id=${identity.sessionId}))` })
        .onConflictDoUpdate({ target: p.connectionId, set: { cursor,
          expiresAt: sql`LEAST(clock_timestamp() + interval '5 seconds', (SELECT expires_at FROM auth_sessions WHERE id=${identity.sessionId}))` },
          setWhere: and(eq(p.docId, docId), eq(p.generation, generation), eq(p.actorId, identity.actorId), eq(p.sessionId, identity.sessionId)) });
    },
    async presence(docId: string, generation: string) {
      const p = schema.docLivePresence;
      const rows = await db.select({ connectionId: p.connectionId, actorId: p.actorId, name: schema.authUsers.name, cursor: p.cursor, expiresAt: p.expiresAt })
        .from(p).innerJoin(schema.authUsers, eq(schema.authUsers.id, p.actorId))
        .innerJoin(schema.authSessions, and(eq(schema.authSessions.id, p.sessionId), gt(schema.authSessions.expiresAt, sql`clock_timestamp()`)))
        .where(and(eq(p.docId, docId), eq(p.generation, generation), gt(p.expiresAt, sql`clock_timestamp()`))).orderBy(p.connectionId).limit(128);
      return rows.map((row) => ({ connectionId: row.connectionId, actor: { kind: 'human' as const, id: row.actorId, name: row.name }, cursor: row.cursor, expiresAt: row.expiresAt.toISOString() }));
    },
    async notify(docId: string) { await db.execute(sql`SELECT pg_notify(${EDITING_CHANNEL}, ${docId})`); },
  };
}

/** SQL session row fence: authority uses current database time and the current persisted identity/name. */
export function editingSessionRows(db: DbExecutor) {
  const s = schema.authSessions;
  async function current(identity: { sessionId: string; actorId: string }, lock: boolean) {
    const select = db.select({ id: s.id }).from(s).where(and(eq(s.id, identity.sessionId), eq(s.userId, identity.actorId), gt(s.expiresAt, sql`clock_timestamp()`)));
    const rows = await (lock ? select.for('share') : select);
    if (!rows.length) return null;
    const [user] = await db.select({ name: schema.authUsers.name }).from(schema.authUsers).where(eq(schema.authUsers.id, identity.actorId));
    return user ? { kind: 'human' as const, id: identity.actorId, name: user.name } : null;
  }
  return { lock: (identity: { sessionId: string; actorId: string }) => current(identity, true),
    current: (identity: { sessionId: string; actorId: string }) => current(identity, false) };
}
