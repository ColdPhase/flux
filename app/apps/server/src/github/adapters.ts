import { artifactResetRows, githubRows, prepareCanonicalArtifactTasks, TaskUseRefusal, type TaskUseFence, accessReader } from '@flux/db';
import {
  directPrerequisiteIds, enforce, evaluateProject, GITHUB_RULE_AUTOMATION, githubRuleUseCases, githubUseCases, ServiceUnavailableError, sortedIds,
  unmetPrerequisites, type Database, type GithubProvider, type GithubTasks, type GithubTaskState, type GithubUnitOfWork, type Transaction, type WorkRecord,
} from '@flux/core';
import { workRepository } from '../work/adapters.js';
import { transactionEventSession, type TransactionEventSession } from '../work/transaction-events.js';
import { githubTransaction } from './transactions.js';
type Provider = GithubProvider & { inTransaction?: (tx: Database) => GithubProvider };
type Retained={scope:{workspaceId:string;projectId:string}|null;fence:TaskUseFence|null};

/** Native task reads and the rule's status changes, joined to the GitHub unit's transaction and final event batch (#74 G-1a). */
function githubTasks(tx: Transaction, events: TransactionEventSession, retained:Retained): GithubTasks {
  const work = workRepository(tx);
  const state = async (record: WorkRecord): Promise<GithubTaskState> => {
    const prerequisites = await work.prerequisiteStates(record.workspaceId, record.id);
    return { id: record.id, workspaceId: record.workspaceId, projectId: record.projectId, status: record.status, blocker: record.blocker,
      parked: !!record.parked, criteria: record.criteria, version: record.version, prerequisitesMet: !!prerequisites && !unmetPrerequisites(prerequisites.prerequisites).length };
  };
  return {
    async find(taskId, lock = false) { const record = await work.findWork(taskId, { lock }); return record ? state(record) : null; },
    async lockForRules(workspaceId, projectId, taskIds) {
      const wanted=()=>directPrerequisiteIds(work,workspaceId,taskIds).then(prior=>sortedIds([...taskIds,...prior],'taskIds'));
      if(retained.scope&&(retained.scope.workspaceId!==workspaceId||retained.scope.projectId!==projectId))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
      if(!retained.fence){
        retained.scope={workspaceId,projectId};
        retained.fence=await prepareCanonicalArtifactTasks(tx,retained.scope,[],(await wanted()).map(id=>({type:'work',id})));
      }
      if((await wanted()).some(id=>!retained.fence!.ids.includes(id)))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
      const tasks = new Map<string, GithubTaskState>();
      for (const taskId of taskIds) {
        const record = await work.findWork(taskId);
        if (record && record.projectId === projectId && record.workspaceId === workspaceId) tasks.set(taskId, await state(record));
      }
      return tasks;
    },
    async move(taskId, change, by) { return state(await work.updateWork(taskId, change, by, 'github_rule')); },
    async updated(principal, task, automated = false) {
      if(!retained.fence||!retained.fence.ids.includes(task.id))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
      await retained.fence.mark([task.id]);
      await events.record(principal, task.workspaceId, 'project.work_updated.v1', task.projectId, { workId: task.id, ...(automated ? { automation: GITHUB_RULE_AUTOMATION } : {}) });
    },
    async names(userIds) {
      const names = await work.names(userIds.map((id) => ({ kind: 'human' as const, id })));
      return new Map(userIds.flatMap((id) => names.has(`human:${id}`) ? [[id, names.get(`human:${id}`)!] as const] : []));
    },
  };
}

export function githubUnitOfWork(db: Database, provider: Provider): GithubUnitOfWork {
  return { run: (work) => githubTransaction(db, async (tx) => {
    const session = transactionEventSession(tx);
    const retained:Retained={scope:null,fence:null};
    const rows=githubRows(tx,{taskFence:()=>retained.fence});
    const reset=async(link:Awaited<ReturnType<typeof rows.link>>)=>{
      if(!retained.fence)throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
      const binding=await rows.binding(link.bindingId);
      const stored=await rows.linkAt(link.id);
      if(!binding||!stored||binding.projectId!==link.projectId||binding.workspaceId!==link.workspaceId||stored.pullId!==link.facts.pullId
        ||binding.state!=='active'||link.state!=='current'||!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(link.facts.headSha))return;
      await artifactResetRows(tx).record(link,{kind:'github_pr',
        id:link.bindingId+':'+binding.repositoryId+':'+stored.pullId+':'+link.taskId,revision:link.facts.headSha},[link.taskId],retained.fence);
    };
    const canonicalRows={...rows,
      async link(input:Parameters<typeof rows.link>[0]){
        const saved=await rows.link(input);
        if(saved.id===input.id)await reset(saved);
        return saved;
      },
      async saveFacts(id:string,facts:Parameters<typeof rows.saveFacts>[1]){
        const prior=await rows.linkAt(id);
        if(!prior)throw new TaskUseRefusal('TASK_TARGET_NOT_FOUND');
        await rows.saveFacts(id,facts);
        if(prior.facts.headSha!==facts.headSha)await reset({...prior,facts,state:'current'});
      },
    };
    const result = await session.run(() => work({ provider: provider.inTransaction?.(tx) ?? provider, rows: canonicalRows, tasks: githubTasks(tx, session,retained), access: {
      async requireProject(principal, action, projectId) {
        const checked = enforce(await evaluateProject(principal, action === 'manage' ? 'project.manage' : action === 'write' ? 'project.write' : 'project.read', projectId, accessReader(tx), { lock: true }), 'project');
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
