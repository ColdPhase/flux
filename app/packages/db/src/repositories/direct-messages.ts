import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { AgentColour } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { openField, openRows, sealFor, sealOf, sealsOf } from '../sealing.js';

/**
 * Drizzle persistence for direct messages (issues #107, #46). The rows satisfy the ports in
 * `packages/core/src/direct-messages/ports.ts` structurally (this package does not depend on
 * core). They make no access decisions: the list query takes the policy's condition over `dms`
 * from the caller, and the server composes it with `visibleFilter`.
 */

const d = schema.dms;
const p = schema.dmParticipants;
const m = schema.dmMessages;
const obs = schema.dmMessageObservations;
const users = schema.authUsers;

type DmRow = typeof d.$inferSelect;
type MessageRow = typeof m.$inferSelect;
const activity = sql`coalesce(${d.lastMessageAt}, ${d.createdAt})`;
// Qualified by hand: Drizzle leaves columns of a single-table select unqualified, and an unqualified
// `id` inside this subquery would name dm_messages.id.
const lastBody = sql<string | null>`(SELECT lm.body FROM dm_messages lm WHERE lm.dm_id = "dms"."id" AND lm.kind = 'text' ORDER BY lm.sequence DESC LIMIT 1)`;
const lastVia = sql<string | null>`(SELECT lm.via FROM dm_messages lm WHERE lm.dm_id = "dms"."id" AND lm.kind = 'text' ORDER BY lm.sequence DESC LIMIT 1)`;
const lastId = sql<string | null>`(SELECT lm.id FROM dm_messages lm WHERE lm.dm_id = "dms"."id" AND lm.kind = 'text' ORDER BY lm.sequence DESC LIMIT 1)`;

export interface NewDmRow {
  id: string; workspaceId: string; kind: 'pair' | 'group'; pairKey: string | null; title: string | null; createdBy: string; participantIds: string[];
}
export interface NewDmMessageRow {
  id: string; workspaceId: string; dmId: string; authorId: string; clientMessageId: string; requestFingerprint: string; body: string;
  /** Set for a private reply: a root of the same DM. */
  threadRootId?: string | null;
  /** The agent whose answer the author posted with Show everyone (#842). */
  via?: string | null;
  viaColour?: AgentColour | null;
}

export function toDmMessageRecord(row: MessageRow, replyCount = 0) {
  return { id: row.id, dmId: row.dmId, authorId: row.authorId, body: row.body, sequence: row.sequence, requestFingerprint: row.requestFingerprint, createdAt: row.createdAt, threadRootId: row.threadRootId, replyCount, via: row.via, viaColour: row.viaColour, kind: row.kind,
    editedAt: row.editedAt, removedAt: row.removedAt };
}

export function dmRows(db: DbExecutor) {
  async function participants(dmIds: string[]) {
    const byDm = new Map<string, { id: string; name: string }[]>();
    if (!dmIds.length) return byDm;
    const rows = await db.select({ dmId: p.dmId, id: p.userId, name: users.name }).from(p)
      .innerJoin(users, eq(users.id, p.userId)).where(inArray(p.dmId, dmIds)).orderBy(asc(p.joinedAt), asc(users.name), asc(p.userId));
    for (const row of rows) byDm.set(row.dmId, [...(byDm.get(row.dmId) ?? []), { id: row.id, name: row.name }]);
    return byDm;
  }
  async function records(read: { row: DmRow; lastMessageId: string | null; lastMessageBody: string | null; lastMessageVia: string | null }[]) {
    // F-030: a DM's title and its last message are sealed in an encrypted workspace; opened here, never in SQL.
    const seals = await sealsOf(db, read.map(({ row }) => row.workspaceId), { write: false });
    const rows = read.map(({ row, lastMessageId, lastMessageBody, lastMessageVia }) => {
      const seal = seals.get(row.workspaceId)!;
      return { row: { ...row, title: openField('dms', 'title', [row.id], row.title, seal) ?? null }, lastMessageVia,
        lastMessageBody: lastMessageId ? openField('dm_messages', 'body', [lastMessageId], lastMessageBody, seal) ?? null : lastMessageBody };
    });
    const people = await participants(rows.map(({ row }) => row.id));
    const pairIds = [...new Set(rows.flatMap(({ row }) => row.pairKey?.split(':') ?? []))];
    const pairNames = new Map(pairIds.length
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, pairIds))).map((u) => [u.id, u.name])
      : []);
    return rows.map(({ row, lastMessageBody, lastMessageVia }) => ({
      pair: row.pairKey ? row.pairKey.split(':').map((id) => ({ id, name: pairNames.get(id) ?? '' })) : null,
      id: row.id, workspaceId: row.workspaceId, kind: row.kind, title: row.title, createdBy: row.createdBy, version: row.version,
      createdAt: row.createdAt, lastMessageAt: row.lastMessageAt, lastMessageBody, lastMessageVia, participants: people.get(row.id) ?? [],
    }));
  }
  async function replyCounts(rootIds: string[]) {
    const counts = new Map<string, number>();
    if (!rootIds.length) return counts;
    const rows = await db.select({ rootId: m.threadRootId, n: count() }).from(m).where(inArray(m.threadRootId, rootIds)).groupBy(m.threadRootId);
    for (const row of rows) if (row.rootId) counts.set(row.rootId, row.n);
    return counts;
  }
  const select = () => db.select({ row: d, lastMessageId: lastId, lastMessageBody: lastBody, lastMessageVia: lastVia }).from(d);
  const open = (rows: MessageRow[]) => openRows(db, 'dm_messages', rows);
  const find = async (id: string) => (await records(await select().where(eq(d.id, id))))[0] ?? null;

  return {
    /** DMs of `workspaceId` matching `audience` (the policy's list condition), latest activity first. */
    async list(workspaceId: string, audience: SQL, page: { limit: number; offset: number }) {
      // F-030 (AC-6): a locked encrypted workspace answers 423 even when the page would be empty.
      await sealOf(db, workspaceId, { write: false });
      const where = and(eq(d.workspaceId, workspaceId), audience);
      const rows = await select().where(where).orderBy(desc(activity), asc(d.id)).limit(page.limit).offset(page.offset);
      const [total] = await db.select({ total: count() }).from(d).where(where);
      return { items: await records(rows), total: total?.total ?? 0 };
    },
    find,
    async lockPair(workspaceId: string, pairKey: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dm-pair:${workspaceId}:${pairKey}`}))`);
    },
    async findPair(workspaceId: string, pairKey: string) {
      return (await records(await select().where(and(eq(d.workspaceId, workspaceId), eq(d.pairKey, pairKey)))))[0] ?? null;
    },
    async insert(dm: NewDmRow) {
      await db.insert(d).values(await sealFor(db, 'dms', dm.workspaceId, { id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, pairKey: dm.pairKey, title: dm.title, createdBy: dm.createdBy }));
      await db.insert(p).values(dm.participantIds.map((userId) => ({ workspaceId: dm.workspaceId, dmId: dm.id, userId })));
      return (await find(dm.id))!;
    },
    async addParticipant(workspaceId: string, dmId: string, userId: string) {
      return (await db.insert(p).values({ workspaceId, dmId, userId }).onConflictDoNothing().returning({ userId: p.userId })).length > 0;
    },
    async removeParticipant(dmId: string, userId: string) {
      return (await db.delete(p).where(and(eq(p.dmId, dmId), eq(p.userId, userId))).returning({ userId: p.userId })).length > 0;
    },
    async rename(dmId: string, title: string | null) {
      const [located] = await db.select({ workspaceId: d.workspaceId }).from(d).where(eq(d.id, dmId));
      await db.update(d).set({ ...(await sealFor(db, 'dms', located!.workspaceId, { title }, { id: dmId })), version: sql`${d.version} + 1` }).where(eq(d.id, dmId));
    },
    async bumpVersion(dmId: string) {
      await db.update(d).set({ version: sql`${d.version} + 1` }).where(eq(d.id, dmId));
    },
    /** The newest `limit` ROOT messages below `beforeSequence` (all when null), ascending, with their reply counts. */
    async window(dmId: string, window: { limit: number; beforeSequence: number | null }) {
      const rows = await open(await db.select().from(m)
        .where(and(eq(m.dmId, dmId), isNull(m.threadRootId), window.beforeSequence === null ? undefined : lt(m.sequence, window.beforeSequence)))
        .orderBy(desc(m.sequence)).limit(window.limit + 1));
      const page = rows.slice(0, window.limit).reverse();
      const counts = await replyCounts(page.map((row) => row.id));
      return { messages: page.map((row) => toDmMessageRecord(row, counts.get(row.id) ?? 0)), hasMoreBefore: rows.length > window.limit };
    },
    /** One message of this DM, root or reply, whose reply count is included. Null for any other id. */
    async message(dmId: string, messageId: string) {
      const [row] = await open(await db.select().from(m).where(and(eq(m.dmId, dmId), eq(m.id, messageId))));
      return row ? toDmMessageRecord(row, row.threadRootId ? 0 : (await replyCounts([row.id])).get(row.id) ?? 0) : null;
    },
    /** The newest `limit` replies of one root below `beforeSequence`, ascending. */
    async threadWindow(dmId: string, rootId: string, window: { limit: number; beforeSequence: number | null }) {
      const rows = await open(await db.select().from(m)
        .where(and(eq(m.dmId, dmId), eq(m.threadRootId, rootId), window.beforeSequence === null ? undefined : lt(m.sequence, window.beforeSequence)))
        .orderBy(desc(m.sequence)).limit(window.limit + 1));
      return { messages: rows.slice(0, window.limit).reverse().map((row) => toDmMessageRecord(row)), hasMoreBefore: rows.length > window.limit };
    },
    async lockClientMessage(dmId: string, authorId: string, clientMessageId: string) {
      // Hash collisions only serialize unrelated sends; the unique constraint stays the final guard.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dm-message:${dmId}:${authorId}:${clientMessageId}`}))`);
    },
    async findMessage(dmId: string, authorId: string, clientMessageId: string) {
      const [row] = await open(await db.select().from(m).where(and(eq(m.dmId, dmId), eq(m.authorId, authorId), eq(m.clientMessageId, clientMessageId))));
      return row ? toDmMessageRecord(row) : null;
    },
    async appendMessage(message: NewDmMessageRow) {
      const [updated] = await db.update(d).set({ nextSequence: sql`${d.nextSequence} + 1`, lastMessageAt: sql`now()` })
        .where(eq(d.id, message.dmId)).returning({ nextSequence: d.nextSequence });
      const [row] = await db.insert(m).values(await sealFor(db, 'dm_messages', message.workspaceId,
        { ...message, threadRootId: message.threadRootId ?? null, via: message.via ?? null, viaColour: message.via ? message.viaColour ?? null : null, sequence: updated!.nextSequence - 1 })).returning();
      return toDmMessageRecord({ ...row!, body: message.body, requestFingerprint: message.requestFingerprint });
    },
    /** Messages of this DM among `ids`, with the facts a receipt run is checked against. Foreign ids are absent. */
    async messageFacts(dmId: string, ids: string[]) {
      if (!ids.length) return [];
      return db.select({ id: m.id, authorId: m.authorId, sequence: m.sequence, threadRootId: m.threadRootId }).from(m).where(and(eq(m.dmId, dmId), inArray(m.id, ids)));
    },
    /** Message ids of one level (the roots, or one root's replies) with sequence in [from, to], and their authors. */
    async levelRange(dmId: string, rootId: string | null, from: number, to: number) {
      return db.select({ id: m.id, authorId: m.authorId }).from(m)
        .where(and(eq(m.dmId, dmId), rootId ? eq(m.threadRootId, rootId) : isNull(m.threadRootId), gte(m.sequence, from), lte(m.sequence, to)));
    },
    /** Idempotent: one row per message and viewer. Returns how many rows were written now. */
    async observe(workspaceId: string, dmId: string, viewerId: string, ids: string[]) {
      if (!ids.length) return 0;
      const written = await db.insert(obs).values(ids.map((messageId) => ({ workspaceId, dmId, messageId, viewerId }))).onConflictDoNothing().returning({ id: obs.messageId });
      return written.length;
    },
    /**
     * Current participants (never `excludeId`) who observed EVERY message in `ids`. The join to dm_participants is
     * what keeps a person who left, or was removed, out of every answer, whatever they once observed.
     */
    async viewersOfAll(dmId: string, ids: string[], excludeId: string) {
      if (!ids.length) return [];
      const distinct = [...new Set(ids)];
      return db.select({ id: users.id, name: users.name, at: sql<Date>`max(${obs.observedAt})`.mapWith(obs.observedAt) }).from(obs)
        .innerJoin(p, and(eq(p.dmId, obs.dmId), eq(p.userId, obs.viewerId)))
        .innerJoin(users, eq(users.id, obs.viewerId))
        .where(and(eq(obs.dmId, dmId), inArray(obs.messageId, distinct), sql`${obs.viewerId} <> ${excludeId}`))
        .groupBy(users.id, users.name)
        .having(sql`count(distinct ${obs.messageId}) = ${distinct.length}`);
    },
    async unreadFrom(dmId: string, viewerId: string, rootId: string | null) {
      const level = rootId ? eq(m.threadRootId, rootId) : isNull(m.threadRootId);
      const [seen] = await db.select({ top: sql<number | null>`max(${m.sequence})` }).from(obs).innerJoin(m, eq(m.id, obs.messageId))
        .where(and(eq(obs.dmId, dmId), eq(obs.viewerId, viewerId), level));
      // Nothing observed at this level: none of it was read, so it all is new.
      const [next] = await db.select({ id: m.id }).from(m)
        .where(and(eq(m.dmId, dmId), level, gt(m.sequence, seen?.top ?? 0), sql`${m.authorId} <> ${viewerId}`, eq(m.kind, 'text'), isNull(m.removedAt)))
        .orderBy(asc(m.sequence)).limit(1);
      return next?.id ?? null;
    },
    async names(userIds: string[]) {
      if (!userIds.length) return [];
      return db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)).orderBy(asc(users.id));
    },
  };
}
