import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { personalRunRows } from './personal-runs.js';

/**
 * Drizzle rows for the sidebar's own state (#1250): the order of a person's Spaces list and "Mark all as read". They satisfy the
 * `SidebarRepository` port of `packages/core/src/sidebar/ports.ts` structurally and make no access decisions: the core use case passes
 * only the spaces the policy lets the person see.
 */

const so = schema.spaceOrder;
const rp = schema.returnPoints;

export function sidebarRows(db: DbExecutor) {
  return {
    async order(userId: string): Promise<string[]> {
      const rows = await db.select({ id: so.projectId }).from(so).where(eq(so.userId, userId)).orderBy(asc(so.position), asc(so.projectId));
      return rows.map((row) => row.id);
    },

    /** The company's Everyone space: visible to the whole company, in the company workspace. It is first for everyone and never stored. */
    async everyone(workspaceIds: string[]): Promise<Set<string>> {
      if (!workspaceIds.length) return new Set();
      const rows = await db.select({ id: schema.projects.id }).from(schema.projects)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.projects.workspaceId))
        .where(and(inArray(schema.projects.workspaceId, workspaceIds), eq(schema.projects.visibility, 'workspace'), eq(schema.workspaces.company, true)));
      return new Set(rows.map((row) => row.id));
    },

    /** The whole order at once; two tabs saving at the same moment wait for each other (the second one wins). */
    async replaceOrder(userId: string, projectIds: string[]) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`space-order:${userId}`}))`);
      await db.delete(so).where(eq(so.userId, userId));
      if (projectIds.length) await db.insert(so).values(projectIds.map((projectId, position) => ({ userId, projectId, position })));
    },

    async lastEvent(recipient: string) {
      const [row] = await db.select({ id: schema.eventAudience.eventId, seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(eq(schema.eventAudience.recipient, recipient)).orderBy(sql`${schema.eventAudience.seq} DESC`).limit(1);
      return row ?? null;
    },

    async audienceSeq(recipient: string, eventId: string) {
      const [row] = await db.select({ seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(and(eq(schema.eventAudience.recipient, recipient), eq(schema.eventAudience.eventId, eventId)));
      return row?.seq ?? null;
    },

    async points(userId: string, keys: string[]) {
      if (!keys.length) return new Map<string, { seq: number }>();
      const rows = await db.select({ key: rp.placeKey, seq: rp.seq }).from(rp).where(and(eq(rp.userId, userId), inArray(rp.placeKey, keys)));
      return new Map(rows.map((row) => [row.key, { seq: row.seq }]));
    },

    /** Forward only: the return view's own rule (`returnRows.advance`), for a space. */
    async advance(userId: string, projectId: string, seq: number) {
      await db.insert(rp).values({ userId, placeKey: `project:${projectId}`, placeType: 'project', projectId, conversationId: null, seq })
        .onConflictDoUpdate({ target: [rp.userId, rp.placeKey],
          set: { seq, savedAt: sql`now()`, previousSeq: sql`${rp.seq}`, previousSavedAt: sql`${rp.savedAt}` }, setWhere: sql`${rp.seq} < ${seq}` });
    },

    /** The point goes back to the one it replaced, or is removed when the place had none (the space is unviewed again): only while it stands at `seq`. */
    async restore(userId: string, projectId: string, seq: number) {
      const key = `project:${projectId}`;
      const back = await db.update(rp).set({ seq: sql`${rp.previousSeq}`, savedAt: sql`${rp.previousSavedAt}`, previousSeq: null, previousSavedAt: null })
        .where(and(eq(rp.userId, userId), eq(rp.placeKey, key), eq(rp.seq, seq), sql`${rp.previousSeq} IS NOT NULL`)).returning({ seq: rp.seq });
      if (back.length) return true;
      const gone = await db.delete(rp).where(and(eq(rp.userId, userId), eq(rp.placeKey, key), eq(rp.seq, seq), sql`${rp.previousSeq} IS NULL`)).returning({ seq: rp.seq });
      return gone.length > 0;
    },

    async readChats(ownerUserId: string) {
      const unread = (await personalRunRows(db).agentChatSummaries(ownerUserId)).filter((chat) => chat.unread > 0).map((chat) => chat.agentId);
      if (!unread.length) return [];
      // The times travel as text so they come back to the microsecond: a JavaScript date has milliseconds only. A list of ids is joined
      // into the statement one placeholder each (a JavaScript array bound whole would not be a PostgreSQL array).
      const ids = sql.join(unread.map((id) => sql`${id}::uuid`), sql`, `);
      const before = await db.execute(sql`SELECT agent_id, read_at::text AS read_at FROM agent_chat_reads WHERE agent_id IN (${ids})`);
      const was = new Map((before.rows as { agent_id: string; read_at: string }[]).map((row) => [row.agent_id, row.read_at]));
      const now = await db.execute(sql`INSERT INTO agent_chat_reads (agent_id, read_at) VALUES ${sql.join(unread.map((id) => sql`(${id}::uuid, now())`), sql`, `)}
        ON CONFLICT (agent_id) DO UPDATE SET read_at = now() RETURNING agent_id, read_at::text AS read_at`);
      return (now.rows as { agent_id: string; read_at: string }[]).map((row) => ({ agentId: row.agent_id, before: was.get(row.agent_id) ?? null, now: row.read_at }));
    },

    async restoreChat(ownerUserId: string, chat: { agentId: string; before: string | null; now: string }) {
      // Only the person's own agent, and only while the chat still shows the time `readChats` set.
      const own = sql`EXISTS (SELECT 1 FROM assistant_settings s WHERE s.agent_id = ${chat.agentId}::uuid AND s.owner_user_id = ${ownerUserId})`;
      const result = chat.before === null
        ? await db.execute(sql`DELETE FROM agent_chat_reads WHERE agent_id = ${chat.agentId}::uuid AND read_at = ${chat.now}::timestamptz AND ${own}`)
        : await db.execute(sql`UPDATE agent_chat_reads SET read_at = ${chat.before}::timestamptz WHERE agent_id = ${chat.agentId}::uuid AND read_at = ${chat.now}::timestamptz AND ${own}`);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
