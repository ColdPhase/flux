import { asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** What one request of the server for a run's agent came to; the same words as the table's `outcome`. */
export type StoredWebRead = { url: string; finalUrl: string; title: string | null; outcome: string; seen: readonly string[] };

/**
 * The addresses the server sent a request to for a run (#918, #953): written by the tool in the transaction that answers the agent,
 * a page that came back and an address that failed or sent the request on alike, read when the run's answer is committed.
 */
export function personalRunWebReadRows(db: DbExecutor) {
  const w = schema.personalRunWebReads;
  return {
    /** Written before the request goes out (outcome `asked`); returns the row, which `settle` closes when the read ends. */
    async add(runId: string, read: StoredWebRead): Promise<string> {
      const [row] = await db.insert(w).values({ runId, url: read.url.slice(0, 2048), finalUrl: read.finalUrl.slice(0, 2048), title: read.title?.slice(0, 300) ?? null,
        outcome: read.outcome as typeof w.$inferInsert.outcome, seen: read.seen.slice(0, 50).map((address) => address.slice(0, 2048)),
        // The clock's own time and not the transaction's: the hops of one read are written one after another and are listed in the order asked.
        readAt: sql`clock_timestamp()` }).returning({ id: w.id });
      return row!.id;
    },
    /** What became of an address that was asked: its outcome, and for a page that came back its title and the addresses written in it. */
    async settle(id: string, end: { outcome: string; title?: string | null; seen?: readonly string[] }) {
      await db.update(w).set({ outcome: end.outcome as typeof w.$inferInsert.outcome, ...(end.title !== undefined ? { title: end.title?.slice(0, 300) ?? null } : {}),
        ...(end.seen ? { seen: end.seen.slice(0, 50).map((address) => address.slice(0, 2048)) } : {}) }).where(eq(w.id, id));
    },
    /** Every distinct address requested, in the order first requested; an address that came back at any time counts as read. */
    async forRun(runId: string): Promise<{ finalUrl: string; outcome: string }[]> {
      const rows = await db.select({ finalUrl: w.finalUrl, outcome: w.outcome }).from(w).where(eq(w.runId, runId)).orderBy(asc(w.readAt), asc(w.id));
      const first = new Map<string, { finalUrl: string; outcome: string }>();
      for (const row of rows) {
        const earlier = first.get(row.finalUrl);
        if (!earlier) first.set(row.finalUrl, row);
        else if (row.outcome === 'read' && earlier.outcome !== 'read') first.set(row.finalUrl, { ...earlier, outcome: 'read' });
      }
      return [...first.values()];
    },
    /** How many different addresses the run has asked for, apart from `except` (an address it asks again is not one more). */
    async askedCount(runId: string, except = ''): Promise<number> {
      const result = await db.execute<{ n: number }>(sql`SELECT count(DISTINCT url)::int AS n FROM personal_run_web_reads WHERE run_id = ${runId}::uuid AND url <> ${except}`);
      return result.rows[0]?.n ?? 0;
    },
    /**
     * The texts whose addresses the run's agent may read (#953): the addresses the run was given when it began (written only by people:
     * its request, the task and the people's messages, fixed at the start in `personal_runs.given`) and the addresses written on the pages
     * the run has read. Matching only: the texts go nowhere.
     */
    async given(runId: string): Promise<string[]> {
      const result = await db.execute<{ text: string | null }>(sql`
        SELECT array_to_string(r.given, E'\n') AS text FROM personal_runs r WHERE r.id = ${runId}::uuid
        UNION ALL SELECT array_to_string(x.seen, E'\n') FROM personal_run_web_reads x WHERE x.run_id = ${runId}::uuid`);
      return result.rows.flatMap((row) => (row.text ? [row.text] : []));
    },
    /**
     * The text a person wrote that a run may be given when it starts (#953, C-30): the task's title, outcome and criteria when a person
     * made the task and no agent has written them since, and the last 100 messages of the run's place that a person wrote and that were not
     * taken back: the conversation's, the space's people's conversations for its main conversation, a DM's text messages (not its "used AI"
     * line); a private chat has none. What an agent wrote (a question to another agent, an answer, a status line, a task it made or edited) is
     * never returned, and neither is an answer a person posted with Show everyone (`via`): it is the agent's text (#842).
     */
    async personTexts(place: { projectId: string | null; conversationId: string | null; dmId: string | null; dmThreadRootId?: string | null }, workId: string | null): Promise<string[]> {
      const task = sql`SELECT concat_ws(E'\n', t.title, t.outcome, t.criteria::text) AS text FROM project_work_items t
        WHERE t.id = ${workId}::uuid AND t.created_by_kind = 'human' AND NOT t.text_by_agent AND COALESCE(t.creation_origin, 'human') = 'human'`;
      // In a DM's thread (#1016) only the thread's own words give an address: they are all the model is given.
      const messages = place.dmId !== null
        ? place.dmThreadRootId
          ? sql`SELECT m.body FROM dm_messages m WHERE m.dm_id = ${place.dmId}::uuid AND m.kind = 'text' AND m.via IS NULL
            AND (m.id = ${place.dmThreadRootId}::uuid OR m.thread_root_id = ${place.dmThreadRootId}::uuid) ORDER BY m.sequence DESC LIMIT 100`
          : sql`SELECT m.body FROM dm_messages m WHERE m.dm_id = ${place.dmId}::uuid AND m.kind = 'text' AND m.via IS NULL ORDER BY m.sequence DESC LIMIT 100`
        : place.conversationId !== null
          ? sql`SELECT m.body FROM project_messages m WHERE m.conversation_id = ${place.conversationId}::uuid AND m.removed_at IS NULL AND m.author_agent_id IS NULL AND m.via IS NULL
            ORDER BY m.sequence DESC LIMIT 100`
          : place.projectId !== null
            ? sql`SELECT m.body FROM project_messages m JOIN project_conversations c ON c.id = m.conversation_id
              WHERE c.project_id = ${place.projectId}::uuid AND c.space = 'people' AND m.removed_at IS NULL AND m.author_agent_id IS NULL AND m.via IS NULL
              ORDER BY m.created_at DESC, m.id DESC LIMIT 100`
            : null;
      const result = await db.execute<{ text: string | null }>(messages ? sql`${task} UNION ALL (${messages})` : task);
      return result.rows.flatMap((row) => (row.text ? [row.text] : []));
    },
  };
}
