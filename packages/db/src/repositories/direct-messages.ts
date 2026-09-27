import { and, asc, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle persistence for direct messages (issues #107, #46). The rows satisfy the ports in
 * `packages/core/src/direct-messages/ports.ts` structurally (this package does not depend on
 * core). They make no access decisions: the list query takes the policy's condition over `dms`
 * from the caller, and the server composes it with `visibleFilter`.
 */

const d = schema.dms;
const p = schema.dmParticipants;
const m = schema.dmMessages;
const users = schema.authUsers;

type DmRow = typeof d.$inferSelect;
type MessageRow = typeof m.$inferSelect;
const activity = sql`coalesce(${d.lastMessageAt}, ${d.createdAt})`;
// Qualified by hand: Drizzle leaves columns of a single-table select unqualified, and an unqualified
// `id` inside this subquery would name dm_messages.id.
const lastBody = sql<string | null>`(SELECT lm.body FROM dm_messages lm WHERE lm.dm_id = "dms"."id" ORDER BY lm.sequence DESC LIMIT 1)`;

export interface NewDmRow {
  id: string; workspaceId: string; kind: 'pair' | 'group'; pairKey: string | null; title: string | null; createdBy: string; participantIds: string[];
}
export interface NewDmMessageRow {
  id: string; workspaceId: string; dmId: string; authorId: string; clientMessageId: string; requestFingerprint: string; body: string;
}

function toMessage(row: MessageRow) {
  return { id: row.id, dmId: row.dmId, authorId: row.authorId, body: row.body, sequence: row.sequence, requestFingerprint: row.requestFingerprint, createdAt: row.createdAt };
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
  async function records(rows: { row: DmRow; lastMessageBody: string | null }[]) {
    const people = await participants(rows.map(({ row }) => row.id));
    return rows.map(({ row, lastMessageBody }) => ({
      id: row.id, workspaceId: row.workspaceId, kind: row.kind, title: row.title, createdBy: row.createdBy, version: row.version,
      createdAt: row.createdAt, lastMessageAt: row.lastMessageAt, lastMessageBody, participants: people.get(row.id) ?? [],
    }));
  }
  const select = () => db.select({ row: d, lastMessageBody: lastBody }).from(d);
  const find = async (id: string) => (await records(await select().where(eq(d.id, id))))[0] ?? null;

  return {
    /** DMs of `workspaceId` matching `audience` (the policy's list condition), latest activity first. */
    async list(workspaceId: string, audience: SQL, page: { limit: number; offset: number }) {
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
      await db.insert(d).values({ id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, pairKey: dm.pairKey, title: dm.title, createdBy: dm.createdBy });
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
      await db.update(d).set({ title, version: sql`${d.version} + 1` }).where(eq(d.id, dmId));
    },
    async bumpVersion(dmId: string) {
      await db.update(d).set({ version: sql`${d.version} + 1` }).where(eq(d.id, dmId));
    },
    async window(dmId: string, window: { limit: number; beforeSequence: number | null }) {
      const rows = await db.select().from(m)
        .where(and(eq(m.dmId, dmId), window.beforeSequence === null ? undefined : lt(m.sequence, window.beforeSequence)))
        .orderBy(desc(m.sequence)).limit(window.limit + 1);
      return { messages: rows.slice(0, window.limit).reverse().map(toMessage), hasMoreBefore: rows.length > window.limit };
    },
    async lockClientMessage(dmId: string, authorId: string, clientMessageId: string) {
      // Hash collisions only serialize unrelated sends; the unique constraint stays the final guard.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dm-message:${dmId}:${authorId}:${clientMessageId}`}))`);
    },
    async findMessage(dmId: string, authorId: string, clientMessageId: string) {
      const [row] = await db.select().from(m).where(and(eq(m.dmId, dmId), eq(m.authorId, authorId), eq(m.clientMessageId, clientMessageId)));
      return row ? toMessage(row) : null;
    },
    async appendMessage(message: NewDmMessageRow) {
      const [updated] = await db.update(d).set({ nextSequence: sql`${d.nextSequence} + 1`, lastMessageAt: sql`now()` })
        .where(eq(d.id, message.dmId)).returning({ nextSequence: d.nextSequence });
      const [row] = await db.insert(m).values({ ...message, sequence: updated!.nextSequence - 1 }).returning();
      return toMessage(row!);
    },
    async names(userIds: string[]) {
      if (!userIds.length) return [];
      return db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)).orderBy(asc(users.id));
    },
  };
}
