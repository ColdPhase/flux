import { githubRows } from '@flux/db';
import {
  directPrerequisiteIds, enforce, evaluateProject, githubRuleUseCases, githubUseCases, lockProjectGraphs, ServiceUnavailableError, sortedIds,
  unmetPrerequisites, type Database, type GithubProvider, type GithubTasks, type GithubTaskState, type GithubUnitOfWork, type Transaction, type WorkRecord,
} from '@flux/core';
import { workRepository } from '../work/adapters.js';
import { transactionEventSession, type TransactionEventSession } from '../work/transaction-events.js';
import { githubTransaction } from './transactions.js';
type Provider = GithubProvider & { inTransaction?: (tx: Database) => GithubProvider };

/** Native task reads and the rule's status changes, joined to the GitHub unit's transaction and final event batch (#74 G-1a). */
function githubTasks(tx: Transaction, events: TransactionEventSession): GithubTasks {
  const work = workRepository(tx);
  const state = async (record: WorkRecord): Promise<GithubTaskState> => {
    const prerequisites = await work.prerequisiteStates(record.workspaceId, record.id);
    return { id: record.id, workspaceId: record.workspaceId, projectId: record.projectId, status: record.status, blocker: record.blocker,
      parked: !!record.parked, criteria: record.criteria, version: record.version, prerequisitesMet: !!prerequisites && !unmetPrerequisites(prerequisites.prerequisites).length };
  };
  return {
    async find(taskId, lock = false) { const record = await work.findWork(taskId, { lock }); return record ? state(record) : null; },
    async lockForRules(workspaceId, projectId, taskIds) {
      await lockProjectGraphs(work, [projectId]);
      await work.lockTasks(workspaceId, sortedIds([...taskIds, ...await directPrerequisiteIds(work, workspaceId, taskIds)], 'taskIds'));
      const tasks = new Map<string, GithubTaskState>();
      for (const taskId of taskIds) {
        const record = await work.findWork(taskId);
        if (record && record.projectId === projectId && record.workspaceId === workspaceId) tasks.set(taskId, await state(record));
      }
      return tasks;
    },
    async move(taskId, change) { return state(await work.updateWork(taskId, change)); },
    async updated(principal, task) { await events.record(principal, task.workspaceId, 'project.work_updated.v1', task.projectId, { workId: task.id }); },
    async names(userIds) {
      const names = await work.names(userIds.map((id) => ({ kind: 'human' as const, id })));
      return new Map(userIds.flatMap((id) => names.has(`human:${id}`) ? [[id, names.get(`human:${id}`)!] as const] : []));
    },
  };
}

export function githubUnitOfWork(db: Database, provider: Provider): GithubUnitOfWork {
  return { run: (work) => githubTransaction(db, async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => work({ provider: provider.inTransaction?.(tx) ?? provider, rows: githubRows(tx), tasks: githubTasks(tx, session), access: {
      async requireProject(principal, action, projectId) {
        const checked = enforce(await evaluateProject(principal, action === 'manage' ? 'project.manage' : action === 'write' ? 'project.write' : 'project.read', projectId, tx, { lock: true }), 'project');
        return { workspaceId: checked.project!.workspaceId };
      },
    } }));
    await session.flushEvents();
    return result;
  }) };
}
/** Without App configuration a rule can still be read or turned off; turning it on needs GitHub. */
export const unavailableGithubProvider: GithubProvider = {
  async repository() { throw new ServiceUnavailableError('GitHub App integration is unavailable', 'GITHUB_UNAVAILABLE'); },
  async pull() { throw new ServiceUnavailableError('GitHub App integration is unavailable', 'GITHUB_UNAVAILABLE'); },
};
export const createGithubUseCases = (db: Database, provider: Provider) => githubUseCases(githubUnitOfWork(db, provider));
export const createGithubRuleUseCases = (db: Database, provider: Provider) => githubRuleUseCases(githubUnitOfWork(db, provider));
