import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import * as schema from '../schema.js';
import { sealFor } from '../sealing.js';
import type { DbExecutor } from './push.js';

/**
 * "AI off" in a direct message (C-73, #1591, migration 0110). Each participant's own choice is a row of `dm_ai_off`; AI is off in the
 * conversation while it has one. These rows make no access decision of their own: every agent read of a direct message asks
 * {@link dmAiRows}' `readable` (or composes {@link dmAiOffSql}), and every check of a run asks `readsAiOff`, so one condition covers
 * every AI path: `/ai`, the run's brief, its tools, the private chat's search, the MCP route's delivery check and the model gateway.
 */

const o = schema.dmAiOff;
const users = schema.authUsers;

/** AI is off in the conversation `dmId` names: the condition an agent's search and reads of a direct message leave out. */
export const dmAiOffSql = (dmId: SQLWrapper) => sql`EXISTS (SELECT 1 FROM dm_ai_off ai_off WHERE ai_off.dm_id = ${dmId})`;

/** One run a turn-off stopped or ended, for its owner's progress event. */
export interface DmAiSweptRun { id: string; workspaceId: string; ownerUserId: string; status: string }

/** A run of an agent's private chat (a request or a schedule of it, C-53), which reads its owner's direct messages (C-73); null for any other. */
export interface ChatRunFacts { id: string; ownerUserId: string; workspaceId: string; engine: string; provider: string }

export function dmAiRows(db: DbExecutor) {
  return {
    /**
     * Who turned AI off in each of these conversations, in the order they did: current participants only (a row goes with its
     * person's place). `lock` holds the conversations' rows (share) first, so a change that is committing is waited for.
     */
    async offBy(dmIds: readonly string[], options: { lock?: boolean } = {}): Promise<Map<string, { id: string; name: string }[]>> {
      const byDm = new Map<string, { id: string; name: string }[]>();
      if (!dmIds.length) return byDm;
      if (options.lock) await db.execute(sql`SELECT id FROM dms WHERE id = ANY(${sql.param([...dmIds])}::uuid[]) ORDER BY id FOR SHARE`);
      const rows = await db.select({ dmId: o.dmId, id: o.userId, name: users.name }).from(o).innerJoin(users, eq(users.id, o.userId))
        .where(inArray(o.dmId, [...dmIds])).orderBy(asc(o.createdAt), asc(o.userId));
      for (const row of rows) byDm.set(row.dmId, [...(byDm.get(row.dmId) ?? []), { id: row.id, name: row.name }]);
      return byDm;
    },

    /** Adds or deletes the person's own choice. True when it changed. The caller holds the conversation's row and checked that they take part. */
    async set(workspaceId: string, dmId: string, userId: string, off: boolean): Promise<boolean> {
      if (off) return (await db.insert(o).values({ workspaceId, dmId, userId }).onConflictDoNothing().returning({ userId: o.userId })).length > 0;
      return (await db.delete(o).where(and(eq(o.dmId, dmId), eq(o.userId, userId))).returning({ userId: o.userId })).length > 0;
    },

    /**
     * The conversation's line of one change (`ai_off` or `ai_on`): a row in its order, read like the line "used AI here": no message to
     * read, search, notify or count. `body` names who still keeps AI off.
     */
    async postLine(dmId: string, workspaceId: string, authorId: string, kind: 'ai_off' | 'ai_on', body: string) {
      const [numbered] = await db.update(schema.dms).set({ nextSequence: sql`${schema.dms.nextSequence} + 1` }).where(eq(schema.dms.id, dmId)).returning({ nextSequence: schema.dms.nextSequence });
      const clientMessageId = randomUUID();
      await db.insert(schema.dmMessages).values(await sealFor(db, 'dm_messages', workspaceId, { id: randomUUID(), workspaceId, dmId, authorId, clientMessageId,
        requestFingerprint: kind, sequence: numbered!.nextSequence - 1, body, kind }));
    },

    /**
     * Whether its owner may give this conversation's words to an agent now: they take part in it and nobody has AI off there. Holds the
     * conversation's row (share) until the transaction ends, so a turn-off that is committing waits for the read or is seen by it.
     */
    async readable(dmId: string, workspaceId: string, ownerUserId: string): Promise<boolean> {
      const rows = await db.execute(sql`SELECT d.id FROM dms d JOIN dm_participants p ON p.dm_id = d.id AND p.user_id = ${ownerUserId}
        WHERE d.id = ${dmId}::uuid AND d.workspace_id = ${workspaceId}::uuid FOR SHARE OF d`);
      if (!rows.rows.length) return false;
      return !(await db.execute(sql`SELECT 1 FROM dm_ai_off WHERE dm_id = ${dmId}::uuid LIMIT 1`)).rows.length;
    },

    /** The run, when it is one of an agent's private chat: a request or a schedule there, never a task's run or a run in a place. */
    async chatRun(runId: string): Promise<ChatRunFacts | null> {
      const r = schema.personalRuns;
      const [row] = await db.select({ id: r.id, ownerUserId: r.ownerUserId, workspaceId: r.workspaceId, engine: r.engine, provider: r.provider, projectId: r.projectId,
        dmId: r.dmId, workId: r.workId, kind: r.kind }).from(r).where(eq(r.id, runId));
      if (!row || row.projectId !== null || row.dmId !== null || row.workId !== null || (row.kind !== 'ask' && row.kind !== 'scheduled')) return null;
      return { id: row.id, ownerUserId: row.ownerUserId, workspaceId: row.workspaceId, engine: row.engine, provider: row.provider };
    },

    /**
     * The AG-4 line of a private chat's read (C-73): "Hubert used AI here (Claude)" in the conversation, once for the run (keyed by the run
     * as its `client_message_id`, which also records that the run was given words of it). True when it was posted now.
     */
    async postReadLine(run: ChatRunFacts, dmId: string, company: string): Promise<boolean> {
      const m = schema.dmMessages;
      const [seen] = await db.select({ id: m.id }).from(m).where(and(eq(m.dmId, dmId), eq(m.authorId, run.ownerUserId), eq(m.clientMessageId, run.id)));
      if (seen) return false;
      const [numbered] = await db.update(schema.dms).set({ nextSequence: sql`${schema.dms.nextSequence} + 1` }).where(eq(schema.dms.id, dmId)).returning({ nextSequence: schema.dms.nextSequence });
      const posted = await db.insert(m).values({ id: randomUUID(), workspaceId: run.workspaceId, dmId, authorId: run.ownerUserId, clientMessageId: run.id,
        requestFingerprint: 'ai_used', sequence: numbered!.nextSequence - 1, body: company, kind: 'ai_used' }).onConflictDoNothing().returning({ id: m.id });
      return posted.length > 0;
    },

    /**
     * Whether AI is off in a conversation the run reads: its own (`dmId`), or one its private chat was given words of (the run's line
     * there). Asked at every check of a run and before every model request, so it reads only the few conversations with AI off.
     */
    async readsAiOff(run: { id: string; ownerUserId: string; dmId: string | null }, options: { lock?: boolean } = {}): Promise<boolean> {
      const rows = await db.execute(sql`SELECT ai_off.dm_id FROM dm_ai_off ai_off
        WHERE ai_off.dm_id = ${run.dmId}::uuid
          OR EXISTS (SELECT 1 FROM dm_messages m WHERE m.dm_id = ai_off.dm_id AND m.author_id = ${run.ownerUserId} AND m.client_message_id = ${run.id}::uuid AND m.kind = 'ai_used')
        LIMIT 1${options.lock ? sql` FOR SHARE` : sql``}`);
      return rows.rows.length > 0;
    },

    /**
     * The turn-off's sweep (C-73, as AG-10's for a space): a queued run in the conversation ends before it reads; a run in it, or a private
     * chat's run that was given words of it, that is reading or dispatching is asked to stop at once, and its token closes. Deletes nothing.
     */
    async stopRuns(dmId: string): Promise<DmAiSweptRun[]> {
      const columns = sql`id, workspace_id AS "workspaceId", owner_user_id AS "ownerUserId", status`;
      const readIt = sql`(dm_id = ${dmId}::uuid OR EXISTS (SELECT 1 FROM dm_messages m WHERE m.dm_id = ${dmId}::uuid AND m.kind = 'ai_used'
        AND m.author_id = personal_runs.owner_user_id AND m.client_message_id = personal_runs.id))`;
      const ended = (await db.execute(sql`UPDATE personal_runs SET status = 'stopped', stopped_at_stage = 'before_read', cost_state = 'released', charged_micros = 0,
          end_reason = 'ai_off', completed_at = now(), updated_at = now()
        WHERE dm_id = ${dmId}::uuid AND status = 'queued' RETURNING ${columns}`)).rows as unknown as DmAiSweptRun[];
      const stopping = (await db.execute(sql`UPDATE personal_runs SET stop_requested_at = now(), updated_at = now(),
          run_token_closed_at = CASE WHEN run_token_jti IS NOT NULL THEN coalesce(run_token_closed_at, now()) ELSE run_token_closed_at END
        WHERE status IN ('reading', 'dispatching') AND stop_requested_at IS NULL AND ${readIt} RETURNING ${columns}`)).rows as unknown as DmAiSweptRun[];
      return [...ended, ...stopping];
    },
  };
}
