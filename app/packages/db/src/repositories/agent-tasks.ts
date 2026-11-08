import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Rows for people's agents taking tasks (#856, F-036 AG-5): the one setting "When someone assigns a task to me", the
 * agents a person may give a task to, and the events the server drains (a task was given to an agent, a run on a task ended).
 * It makes no access decision; the use cases of `packages/core/src/agent-tasks` and the work use cases ask the policy.
 */

type Actor = { kind: 'human' | 'agent'; id: string };
const t = schema.agentTaskTaking;
const ev = schema.agentTaskEvents;
const a = schema.agents;
const as = schema.assistantSettings;
const r = schema.personalRuns;

/** A row that keeps failing is left after this many tries; it is a bound, not a rule anybody meets. */
export const AGENT_TASK_EVENT_ATTEMPTS = 5;
/**
 * After the tries above, the give-up itself is tried this many times (each a minute apart at most). If it fails every time, the event is
 * left unhandled with `attempts` at the sum, which an operator can see (`handled_at IS NULL AND attempts >= 10`), and is not claimed again.
 */
export const AGENT_TASK_GIVE_UP_ATTEMPTS = 5;

/**
 * The agents a person may give a task to: their own agents (F-036 AG-1, #857), every one that has an AI setup in Flux and
 * has not been deleted. Local clients are not among them: they work on their owner's own computer.
 */
export function ownServerAgents(db: DbExecutor, ownerUserId: string) {
  return db.select({ id: a.id, name: a.name, workspaceId: a.workspaceId }).from(as)
    .innerJoin(a, eq(a.id, as.agentId))
    .where(and(eq(as.ownerUserId, ownerUserId), eq(a.ownerUserId, ownerUserId), isNull(a.revokedAt)))
    .orderBy(asc(a.createdAt), asc(a.id));
}

export function agentTaskRows(db: DbExecutor) {
  return {
    ownServerAgents: (ownerUserId: string) => ownServerAgents(db, ownerUserId),

    /** The agent and its owner, whoever asks; callers authorize before using it. */
    async agent(agentId: string) {
      const [row] = await db.select({ id: a.id, name: a.name, workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, revokedAt: a.revokedAt }).from(a).where(eq(a.id, agentId));
      return row ?? null;
    },

    /** The unfinished tasks an agent of this person holds, to hand back when the agent is deleted. */
    async heldBy(agentId: string, ownerUserId: string) {
      const w = schema.projectWorkItems;
      return db.select({ id: w.id, version: w.version }).from(w).innerJoin(a, eq(a.id, w.ownerAgentId))
        .where(and(eq(w.ownerAgentId, agentId), eq(a.ownerUserId, ownerUserId), sql`${w.status} not in ('done', 'not_pursued')`))
        .orderBy(asc(w.createdAt), asc(w.id));
    },

    /** Whether the agent is one of this person's own server agents (the Owner field offers these and no others). */
    async isOwnServerAgent(ownerUserId: string, agentId: string) {
      const [row] = await db.select({ id: a.id }).from(as).innerJoin(a, eq(a.id, as.agentId))
        .where(and(eq(as.ownerUserId, ownerUserId), eq(a.ownerUserId, ownerUserId), eq(a.id, agentId), isNull(a.revokedAt)));
      return Boolean(row);
    },

    async taking(ownerUserId: string) {
      const [row] = await db.select({ agentId: t.agentId }).from(t).where(eq(t.ownerUserId, ownerUserId));
      return row?.agentId ?? null;
    },

    async setTaking(ownerUserId: string, agentId: string | null) {
      if (agentId === null) { await db.delete(t).where(eq(t.ownerUserId, ownerUserId)); return; }
      await db.insert(t).values({ ownerUserId, agentId }).onConflictDoUpdate({ target: t.ownerUserId, set: { agentId, updatedAt: new Date() } });
    },

    /**
     * A task was given to `owner`. Written in the caller's transaction, only when the server has something to do: any agent
     * owner, or a person who chose an agent and was not given the task by themselves, by their own agent or by their own rule.
     */
    async noteAssigned(workId: string, owner: Actor, by: Actor, via?: string) {
      if (owner.kind === 'agent') {
        await db.insert(ev).values({ kind: 'assigned', workId, ownerAgentId: owner.id, byKind: by.kind, byId: by.id });
        return;
      }
      if (via === 'agent_rule' || via === 'agent_deleted' || (by.kind === 'human' && by.id === owner.id)) return;
      if (by.kind === 'agent') {
        const [mine] = await db.select({ id: a.id }).from(a).where(and(eq(a.id, by.id), eq(a.ownerUserId, owner.id)));
        if (mine) return;
      }
      await db.execute(sql`INSERT INTO agent_task_events (kind, work_id, owner_user_id, by_kind, by_id)
        SELECT 'assigned', ${workId}::uuid, ${owner.id}, ${by.kind}, ${by.id} WHERE EXISTS (SELECT 1 FROM agent_task_taking WHERE owner_user_id = ${owner.id})`);
    },

    /** A task was taken away from `agentId` by someone else: only when that agent has a run on it in flight, which then has to stop. */
    async noteReleased(workId: string, agentId: string, by: Actor) {
      await db.execute(sql`INSERT INTO agent_task_events (kind, work_id, owner_agent_id, by_kind, by_id)
        SELECT 'released', ${workId}::uuid, ${agentId}::uuid, ${by.kind}, ${by.id}
        WHERE EXISTS (SELECT 1 FROM personal_runs WHERE work_id = ${workId}::uuid AND agent_id = ${agentId}::uuid AND status IN ('queued', 'reading', 'dispatching'))`);
    },

    /**
     * The oldest event nobody has handled and that is due, locked until the transaction ends (another API replica skips it). One that
     * has failed `AGENT_TASK_EVENT_ATTEMPTS` times is claimed too: the drain does not try it again, it tells the task's owner. If even
     * that fails `AGENT_TASK_GIVE_UP_ATTEMPTS` times it is left as it is.
     */
    async claimNext() {
      const [row] = await db.select().from(ev).where(and(isNull(ev.handledAt), lt(ev.attempts, AGENT_TASK_EVENT_ATTEMPTS + AGENT_TASK_GIVE_UP_ATTEMPTS),
        or(isNull(ev.nextTryAt), sql`${ev.nextTryAt} <= now()`)))
        .orderBy(asc(ev.createdAt), asc(ev.id)).limit(1).for('update', { skipLocked: true });
      return row ?? null;
    },

    async markHandled(id: string) {
      await db.update(ev).set({ handledAt: new Date() }).where(eq(ev.id, id));
    },

    /**
     * After a failed try, in its own transaction: the event stays, counts, and waits a little longer each time before its next try (the
     * fifth failure is due at once, for the drain to give it up). Only an event nobody has handled is counted: another replica may have
     * taken it just after this try failed and done it, and that must not be given up. Null for such an event.
     */
    async failed(id: string) {
      const [row] = await db.update(ev).set({ attempts: sql`${ev.attempts} + 1`,
        nextTryAt: sql`now() + (CASE WHEN ${ev.attempts} + 1 = ${AGENT_TASK_EVENT_ATTEMPTS} THEN 0 ELSE least(power(${ev.attempts} + 1, 2), 60)::int END * interval '1 second')` })
        .where(and(eq(ev.id, id), isNull(ev.handledAt))).returning({ attempts: ev.attempts });
      return row ? { attempts: row.attempts, waitSeconds: row.attempts === AGENT_TASK_EVENT_ATTEMPTS ? 0 : Math.min(row.attempts * row.attempts, 60) } : null;
    },

    /** Seconds until the earliest event that failed and waits for its time, or null: what a drain sets its one timer from (also after a restart). */
    async nextDueIn() {
      const result = await db.execute<{ wait: number | null }>(sql`SELECT extract(epoch FROM (min(next_try_at) - now()))::float8 AS wait
        FROM agent_task_events WHERE handled_at IS NULL AND next_try_at > now() AND attempts < ${AGENT_TASK_EVENT_ATTEMPTS + AGENT_TASK_GIVE_UP_ATTEMPTS}`);
      const wait = result.rows[0]?.wait;
      return wait === null || wait === undefined ? null : Math.max(0, Number(wait));
    },

    /** Who last changed the task's owner (#488 activity): a rule's hand-back by the agent reads differently from a person taking the task back. */
    async lastOwnerChange(workId: string) {
      const [row] = await db.select({ kind: schema.projectTaskActivity.actorKind, id: schema.projectTaskActivity.actorId }).from(schema.projectTaskActivity)
        .where(and(eq(schema.projectTaskActivity.workId, workId), eq(schema.projectTaskActivity.kind, 'owner')))
        .orderBy(desc(schema.projectTaskActivity.createdAt), desc(schema.projectTaskActivity.id)).limit(1);
      return row ?? null;
    },

    /** Handled events older than a week are not needed again. */
    async prune() {
      await db.delete(ev).where(sql`${ev.handledAt} < now() - interval '7 days'`);
    },

    /**
     * The task's people (TA-1, C-10): its creator, its owner and anyone who wrote in its thread. When an agent made or holds the task, its
     * owner is the person; a message written by an agent adds nobody (C-5).
     */
    async taskPeople(workId: string) {
      const result = await db.execute<{ id: string }>(sql`SELECT DISTINCT uid AS id FROM (
        SELECT CASE WHEN w.created_by_kind = 'human' THEN w.created_by_id ELSE (SELECT owner_user_id FROM agents WHERE id::text = w.created_by_id) END AS uid FROM project_work_items w WHERE w.id = ${workId}::uuid
        UNION ALL SELECT COALESCE(w.owner_user_id, (SELECT owner_user_id FROM agents WHERE id = w.owner_agent_id)) FROM project_work_items w WHERE w.id = ${workId}::uuid
        UNION ALL SELECT m.author_id FROM project_messages m JOIN project_task_discussions d ON d.conversation_id = m.conversation_id WHERE d.work_id = ${workId}::uuid AND m.author_id IS NOT NULL
      ) people WHERE uid IS NOT NULL`);
      return result.rows.map((row) => row.id);
    },

    /** The runs on a task, newest first: its state in one plain line is read from the first. */
    runsOfWork(workId: string, limit: number) {
      return db.select().from(r).where(eq(r.workId, workId)).orderBy(desc(r.createdAt), desc(r.id)).limit(limit);
    },

    /** A run that continues this one after the provider's limit (#854), if there is one. */
    async successor(runId: string) {
      const [row] = await db.select().from(r).where(eq(r.retryOfRunId, runId)).orderBy(desc(r.createdAt)).limit(1);
      return row ?? null;
    },

    /** Stop was pressed on a run: who, and when. A run that has not been dispatched ends at once, as for the owner. */
    async requestStop(runId: string, by: string) {
      const [row] = await db.update(r).set({ stopRequestedAt: new Date(), stopRequestedBy: by, updatedAt: new Date() })
        .where(and(eq(r.id, runId), sql`${r.stopRequestedAt} IS NULL`)).returning({ id: r.id });
      return Boolean(row);
    },

    /** The names of people, for "Stopped by Maja". */
    async personName(userId: string) {
      const [row] = await db.select({ name: schema.authUsers.name }).from(schema.authUsers).where(eq(schema.authUsers.id, userId));
      return row?.name ?? null;
    },
  };
}
