import { artifactResetRows, githubRows, proactiveOutboxRows, referencedTaskIds, workRows, type DbExecutor, visibleFilter, accessReader } from '@flux/db';
import {
  evaluateProject,
  createWorkContributions,
  createWorkUseCases,
  COMPARISON_QUIET_WINDOW_MS,
  type Database,
  type WorkPorts,
  type WorkRepository,
  type WorkUnitOfWork,
  type Transaction,
} from '@flux/core';
import { taskDiscussionInEventSession, taskDiscussionPorts } from './task-discussions.js';
import { transactionEventSession, type TransactionEventSession } from './transaction-events.js';
import { policyWorkAccess } from './access.js';
import { projectAuthorOwners } from '../conversation/author-owners.js';
import type { AgentProjectOwner } from '@flux/contracts';
export { policyWorkAccess } from './access.js';

// Adapters that connect the core work use cases (#101) to the access policy, the Drizzle rows
// and the event log. Core defines the ports (#46); the server assembles them per transaction.

export function workRepository(tx: DbExecutor): WorkRepository {
  const rows = workRows(tx);
  return {
    ...rows,
    resetArtifact: (scope,boundary,retained)=>artifactResetRows(tx).canonical(scope,
      {kind:boundary.kind,id:boundary.id},boundary,retained),
    /** "Let linked PRs move this task" (#74 G-1a) is part of the native task read model. */
    githubRules: (taskIds) => githubRows(tx).taskRules(taskIds),
    suspendGithubRule: (task) => githubRows(tx).suspendRuleForOverride(task),
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listBlockedFor(principal, workspaceId, userId, page) {
      return rows.listBlockedFor(workspaceId, userId, await visibleFilter(principal, workspaceId, 'project', tx), page);
    },
    async listAssignedVisible(principal, workspaceId, owner, page) {
      return rows.listAssigned(workspaceId, owner, await visibleFilter(principal, workspaceId, 'project', tx), page);
    },
    /** The task detail's rule for an agent's owner (#339 AC-2), in the bounded groups the helper accepts (#488 activity). */
    async agentOwners(projectId, workspaceId, agentIds) {
      const owners = new Map<string, AgentProjectOwner>();
      for (let from = 0; from < agentIds.length; from += 100)
        for (const [id, owner] of await projectAuthorOwners(tx, projectId, workspaceId, agentIds.slice(from, from + 100))) owners.set(id, owner);
      return owners;
    },
  };
}

/**
 * Every work adapter composes the mandatory contribution hook over the SAME transaction and event session
 * as the work use cases (#154), so a saved blocker or a published result contributes to its canonical
 * task thread atomically and its events join the one final batch. There is no adapter without the hook.
 */
function workPorts(tx: Transaction, events: TransactionEventSession): WorkPorts {
  const eligibleComparisons: string[] = [];
  return {
    access: policyWorkAccess(tx),
    work: workRepository(tx),
    events,
    contributions: createWorkContributions(taskDiscussionPorts(tx, events)),
    backgroundComparison: { async prepareHumanNegative(projectId, authorId) {
      void authorId;
      const rows = proactiveOutboxRows(tx);
      eligibleComparisons.length = 0;
      // F-029: inside the person's own write, check first and select nothing while AI is off (never fail the write).
      const access = policyWorkAccess(tx);
      if (!(await access.aiAllowed(projectId))) return;
      const rules = await rows.enabledRules(projectId);
      const authorized: typeof rules = [];
      for (const rule of rules) {
        const owner = await evaluateProject({ kind: 'human', id: rule.ownerUserId }, 'project.write', projectId, accessReader(tx), { lock: true });
        const agent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', projectId, accessReader(tx), { lock: true });
        if (owner.allowed && agent.allowed && agent.actor?.agent?.ownerUserId === rule.ownerUserId) authorized.push(rule);
      }
      for (const rule of [...authorized].sort((a, b) => a.id.localeCompare(b.id))) {
        const retained = await rows.rule(rule.id);
        if (retained?.status === 'enabled' && retained.ownerUserId === rule.ownerUserId && retained.agentId === rule.agentId && retained.projectId === projectId) eligibleComparisons.push(rule.id);
      }
    }, async taskTargets(resultId) {
      const rows = proactiveOutboxRows(tx);
      const refs = (await Promise.all(eligibleComparisons.map((ruleId) => rows.sourceSnapshot(resultId, ruleId)))).flatMap((snapshot) => snapshot.sources);
      return referencedTaskIds(tx, refs);
    }, async enqueueHumanNegative(resultId, projectId, authorId) {
      return proactiveOutboxRows(tx).enqueueHumanNegative(resultId, projectId, authorId, eligibleComparisons, new Date(Date.now() + COMPARISON_QUIET_WINDOW_MS));
    } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function workUnitOfWork(db: Database): WorkUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => work(workPorts(tx, session)));
    await session.flushEvents();
    return result;
  }) };
}

/** Existing native commands share the composing caller's event lifetime. */
export function nativeWorkInEventSession(tx: Transaction, session: TransactionEventSession) {
  const ports = workPorts(tx, session);
  return { ...createWorkUseCases({ run: (action) => session.run(() => action(ports)) }),
    ...taskDiscussionInEventSession(tx, session) };
}

/** One caller-owned transaction, all native preparation, one final audience batch. */
export function nativeWorkInTransaction(tx: Transaction) {
  const session = transactionEventSession(tx);
  return { ...nativeWorkInEventSession(tx, session),
    get eventIntents() { return session.eventIntents; }, flushEvents: session.flushEvents };
}

/** The work use cases bound to a connection or transaction. */
export const workUseCases = (db: Database) => createWorkUseCases(workUnitOfWork(db));
