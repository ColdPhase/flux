import { createHash } from 'node:crypto';
import { and, asc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
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
export function liveEditingRows<Codec extends State>(db: DbExecutor, decodeState: (value: Record<string, unknown>) => Codec, confirmation?: EditingConfirmationPolicy | null) {
  const summary = { docId: h.docId, workspaceId: h.workspaceId, projectId: h.projectId, generation: h.generation, sequence: h.sequence,
    body: h.body, hash: h.hash, savedVersion: h.savedVersion, savedSequence: h.savedSequence, snapshotSequence: h.snapshotSequence,
    revision: h.revision, initialized: sql<boolean>`${h.codecState} IS NOT NULL` };
  const presentSummary = (row: { docId: string; workspaceId: string; projectId: string; generation: string; sequence: number; body: string; hash: string;
    savedVersion: number; savedSequence: number; snapshotSequence: number; revision: number; initialized: boolean }) => ({
    resourceId: row.docId, workspaceId: row.workspaceId, projectId: row.projectId, generation: row.generation, sequence: row.sequence,
    body: row.body, hash: row.hash, savedVersion: row.savedVersion, savedSequence: row.savedSequence,
    snapshotSequence: row.snapshotSequence, revision: row.revision, initialized: row.initialized === true });
  const present = (row: typeof h.$inferSelect) => ({ ...presentSummary({ ...row, initialized: row.codecState !== null }),
    codecState: row.codecState ? decodeState(row.codecState) : null });
  return {
    /** The locked head with its snapshot (codec state at snapshotSequence, not necessarily at sequence). */
    async lockHead(docId: string) { const [row] = await db.select().from(h).where(eq(h.docId, docId)).for('update'); return row ? present(row) : null; },
    async lockHeadSummary(docId: string) {
      const [row] = await db.select(summary).from(h).where(eq(h.docId, docId)).for('update');
      return row ? presentSummary(row) : null;
    },
    /** The snapshot of a head this transaction has locked. */
    async snapshot(docId: string) {
      const [row] = await db.select({ codecState: h.codecState, snapshotSequence: h.snapshotSequence }).from(h).where(eq(h.docId, docId));
      return row?.codecState ? { state: decodeState(row.codecState), sequence: row.snapshotSequence } : null;
    },
    async insertHead(doc: SavedDoc, generation: string, state: Codec) {
      const [row] = await db.insert(h).values({ docId: doc.doc.id, workspaceId: doc.doc.workspaceId, projectId: doc.doc.projectId,
        generation, sequence: state.sequence, body: state.body, hash: hash(state.body), savedVersion: doc.current.version, savedSequence: 0,
        codecState: state, snapshotSequence: state.sequence }).returning();
      return present(row!);
    },
    /** Writes the complete state as the snapshot at its own sequence (initialization, enrollment). */
    async replaceState(head: { resourceId: string; generation: string }, state: Codec, bodyHash: string) {
      if (state.room !== head.resourceId || state.generation !== head.generation) throw new Error('Codec state has another namespace');
      const changed = await db.update(h).set({ body: state.body, hash: bodyHash, sequence: state.sequence, codecState: state,
        snapshotSequence: state.sequence, revision: sql`${h.revision} + 1`, updatedAt: new Date() })
        .where(and(eq(h.docId, head.resourceId), eq(h.generation, head.generation))).returning({ revision: h.revision });
      if (changed.length !== 1) throw new Error('The locked live head disappeared');
      return changed[0]!.revision;
    },
    /**
     * Appends one admitted text update to the log with the ledger entries it added and advances the
     * locked head. The whole state is written only when `snapshot` is given (bounded compaction).
     */
    async commitUpdate(head: { resourceId: string; generation: string; sequence: number; revision: number },
      next: { sequence: number; body: string; hash: string }, log: { actor: string; uuid: string; bytes: Uint8Array; fingerprint: string; ledger: Record<string, unknown> },
      snapshot: Codec | null) {
      if (next.sequence !== head.sequence + 1 || (snapshot && (snapshot.sequence !== next.sequence || snapshot.room !== head.resourceId || snapshot.generation !== head.generation))) {
        throw new Error('A logged update must advance the locked head by one');
      }
      const changed = await db.update(h).set({ sequence: next.sequence, body: next.body, hash: next.hash, revision: sql`${h.revision} + 1`, updatedAt: new Date(),
        ...(snapshot ? { codecState: snapshot, snapshotSequence: next.sequence } : {}) })
        .where(and(eq(h.docId, head.resourceId), eq(h.generation, head.generation), eq(h.sequence, head.sequence), eq(h.revision, head.revision)))
        .returning({ revision: h.revision });
      if (changed.length !== 1) throw new Error('The locked live head changed');
      await db.insert(u).values({ docId: head.resourceId, generation: head.generation, sequence: next.sequence, actorId: log.actor,
        commandId: log.uuid, fingerprint: log.fingerprint, bytes: Buffer.from(log.bytes).toString('base64'), ledger: log.ledger });
      return changed[0]!.revision;
    },
    /** Logged updates (afterSequence, upToSequence] with their ledger entries, for rebuilding a state. */
    async log(docId: string, generation: string, afterSequence: number, upToSequence: number) {
      const rows = await db.select({ sequence: u.sequence, bytes: sql<Buffer>`decode(${u.bytes}, 'base64')`, ledger: u.ledger }).from(u)
        .where(and(eq(u.docId, docId), eq(u.generation, generation), gt(u.sequence, afterSequence), lte(u.sequence, upToSequence))).orderBy(asc(u.sequence));
      return rows;
    },
    async replica(docId: string, generation: string, replicaId: number) {
      const [row] = await db.select().from(r).where(and(eq(r.docId, docId), eq(r.generation, generation), eq(r.replicaId, replicaId))).for('update');
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
    /**
     * Up to `limit` confirmed updates after `afterSequence`, in order. Their stored sizes are summed
     * before any bytes load: the batch stops once it reaches `maxBytes`, but always holds the first.
     */
    async updates(docId: string, generation: string, afterSequence: number, limit: number, maxBytes = Number.MAX_SAFE_INTEGER) {
      const sizes = await db.select({ sequence: u.sequence, size: sql<number>`octet_length(${u.bytes})::int` }).from(u)
        .where(and(eq(u.docId, docId), eq(u.generation, generation), gt(u.sequence, afterSequence))).orderBy(asc(u.sequence)).limit(limit);
      let last = afterSequence; let total = 0;
      for (const row of sizes) { if (last > afterSequence && total + row.size > maxBytes) break; total += row.size; last = row.sequence; }
      if (last === afterSequence) return [];
      const rows = await db.select({ sequence: u.sequence, bytes: sql<Buffer>`decode(${u.bytes}, 'base64')`, commandId: u.commandId,
        actorId: u.actorId, name: schema.authUsers.name, result: i.receipt }).from(u)
        .innerJoin(i, and(eq(i.actorId, u.actorId), eq(i.commandId, u.commandId)))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, u.actorId))
        .where(and(eq(u.docId, docId), eq(u.generation, generation), gt(u.sequence, afterSequence), lte(u.sequence, last))).orderBy(asc(u.sequence));
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
        .where(and(eq(p.docId, docId), eq(p.generation, generation), gt(p.expiresAt, sql`clock_timestamp()`),
          editingConfirmationCurrent(sql`${p.sessionId}`, sql`${p.actorId}`, confirmation))).orderBy(p.connectionId).limit(128);
      return rows.map((row) => ({ connectionId: row.connectionId, actor: { kind: 'human' as const, id: row.actorId, name: row.name }, cursor: row.cursor, expiresAt: row.expiresAt.toISOString() }));
    },
    /** One final recipient/producer clock observation; the caller hands off synchronously after it. */
    async currentPresenceFence(identity: { sessionId: string; actorId: string }, docId: string, generation: string) {
      const result = await db.execute<{ recipientAlive: boolean; presenceIds: string[] }>(sql`
        WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT EXISTS(SELECT 1 FROM auth_sessions session, moment m
          WHERE session.id = ${identity.sessionId} AND session.user_id = ${identity.actorId} AND session.expires_at > m.at
            AND ${editingConfirmationCurrent(sql`session.id`, sql`session.user_id`, confirmation, sql`m.at`)}) AS "recipientAlive",
          ARRAY(SELECT presence.connection_id::text FROM doc_live_presence presence
            JOIN auth_sessions session ON session.id = presence.session_id AND session.user_id = presence.actor_id, moment m
            WHERE presence.doc_id = ${docId} AND presence.generation = ${generation}
              AND presence.expires_at > m.at AND session.expires_at > m.at
              AND ${editingConfirmationCurrent(sql`session.id`, sql`session.user_id`, confirmation, sql`m.at`)}
            ORDER BY presence.connection_id LIMIT 128) AS "presenceIds"`);
      return result.rows[0]!;
    },
    async notify(docId: string) { await db.execute(sql`SELECT pg_notify(${EDITING_CHANNEL}, ${docId})`); },
  };
}

/** Server configuration only; no provider token or browser-supplied authority enters this fence. */
export interface EditingConfirmationPolicy { providerId: string; confirmationMaxAgeMs: number }

/** The same last-confirmation rule as F-024 S2, evaluated at the final SQL clock without a provider call. */
export function editingConfirmationCurrent(sessionId: string | SQL, actorId: string | SQL,
  confirmation?: EditingConfirmationPolicy | null, moment: SQL = sql`clock_timestamp()`) {
  if (!confirmation) return sql`TRUE`;
  return sql`NOT EXISTS (
    SELECT 1 FROM auth_session_identities identity
    WHERE identity.session_id = ${sessionId} AND identity.method = ${confirmation.providerId}
      AND (NOT EXISTS (SELECT 1 FROM auth_accounts account
        WHERE account.user_id = ${actorId} AND account.provider_id = ${confirmation.providerId})
      OR EXISTS (SELECT 1 FROM auth_accounts account
        LEFT JOIN auth_idp_standing standing ON standing.user_id = account.user_id AND standing.provider_id = account.provider_id
        WHERE account.user_id = ${actorId} AND account.provider_id = ${confirmation.providerId}
          AND (GREATEST(account.confirmed_at, standing.confirmed_at) IS NULL
            OR GREATEST(account.confirmed_at, standing.confirmed_at) < ${moment} - ${confirmation.confirmationMaxAgeMs} * interval '1 millisecond')))
  )`;
}

/** SQL session row fence: authority uses current database time and the current persisted identity/name. */
export function editingSessionRows(db: DbExecutor, confirmation?: EditingConfirmationPolicy | null) {
  const s = schema.authSessions;
  async function current(identity: { sessionId: string; actorId: string }, lock: boolean) {
    const select = db.select({ name: schema.authUsers.name }).from(s)
      .innerJoin(schema.authUsers, eq(schema.authUsers.id, s.userId))
      .where(and(eq(s.id, identity.sessionId), eq(s.userId, identity.actorId), gt(s.expiresAt, sql`clock_timestamp()`),
        editingConfirmationCurrent(sql`${s.id}`, sql`${s.userId}`, confirmation)));
    const [user] = await (lock ? select.for('share', { of: s }) : select);
    return user ? { kind: 'human' as const, id: identity.actorId, name: user.name } : null;
  }
  return { lock: (identity: { sessionId: string; actorId: string }) => current(identity, true),
    current: (identity: { sessionId: string; actorId: string }) => current(identity, false) };
}
