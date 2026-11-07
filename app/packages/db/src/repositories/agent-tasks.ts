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
const pa = schema.personalRunAgents;
const r = schema.personalRuns;

/** A row that keeps failing is left after this many tries; it is a bound, not a rule anybody meets. */
export const AGENT_TASK_EVENT_ATTEMPTS = 5;

/**
 * The agents a person may give a task to: their own agents that run on the server. Today that is the agent of their
 * assistant, per company; the agents of #857 are listed here too, which is the one place that changes.
 */
export function ownServerAgents(db: DbExecutor, ownerUserId: string) {
  return db.select({ id: a.id, name: a.name, workspaceId: a.workspaceId }).from(pa)
    .innerJoin(a, and(eq(a.workspaceId, pa.workspaceId), eq(a.id, pa.agentId)))
    .where(and(eq(pa.ownerUserId, ownerUserId), eq(a.ownerUserId, ownerUserId), isNull(a.revokedAt)))
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

    /** Whether the agent is one of this person's own server agents (the Owner field offers these and no others). */
    async isOwnServerAgent(ownerUserId: string, agentId: string) {
      const [row] = await db.select({ id: a.id }).from(pa).innerJoin(a, and(eq(a.workspaceId, pa.workspaceId), eq(a.id, pa.agentId)))
        .where(and(eq(pa.ownerUserId, ownerUserId), eq(a.ownerUserId, ownerUserId), eq(a.id, agentId), isNull(a.revokedAt)));
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
      if (via === 'agent_rule' || (by.kind === 'human' && by.id === owner.id)) return;
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

    /** The oldest event nobody has handled and that is due, locked until the transaction ends (another API replica skips it). */
    async claimNext() {
      const [row] = await db.select().from(ev).where(and(isNull(ev.handledAt), lt(ev.attempts, AGENT_TASK_EVENT_ATTEMPTS),
        or(isNull(ev.nextTryAt), sql`${ev.nextTryAt} <= now()`)))
        .orderBy(asc(ev.createdAt), asc(ev.id)).limit(1).for('update', { skipLocked: true });
      return row ?? null;
    },

    async markHandled(id: string) {
      await db.update(ev).set({ handledAt: new Date() }).where(eq(ev.id, id));
    },

    /**
     * After a failed try, in its own transaction: the event stays, counts, and waits a little longer each time before its next try.
     * Returns how many tries it has had and how long it waits (seconds).
     */
    async failed(id: string) {
      const [row] = await db.update(ev).set({ attempts: sql`${ev.attempts} + 1`,
        nextTryAt: sql`now() + (least(power(${ev.attempts} + 1, 2), 60)::int * interval '1 second')` }).where(eq(ev.id, id)).returning({ attempts: ev.attempts });
      const attempts = row?.attempts ?? AGENT_TASK_EVENT_ATTEMPTS;
      return { attempts, waitSeconds: Math.min(attempts * attempts, 60) };
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
