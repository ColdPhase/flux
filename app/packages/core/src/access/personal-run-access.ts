import type { Executor } from '../types.js';
import { WorkspaceAiBlockedError } from './errors.js';
import type { PersonalRunAccess } from '../personal-runs/ports.js';
import { accessName, enforce, evaluateAgent, evaluateProject, evaluateSketch, requireWorkspaceAi, workspaceAi } from './policy.js';

/**
 * The access policy as the personal-run use cases' `PersonalRunAccess` port (issue #68). It uses
 * the same evaluators as `authorize` and reads current rows on every call; a person-owned agent
 * is capped by its owner's current access there. Pass the unit of work's transaction so `lock`
 * holds until it commits.
 */
export function policyPersonalRunAccess(db: Executor): PersonalRunAccess {
  return {
    async requireProject(principal, action, projectId, options) {
      const checked = enforce(await evaluateProject(principal, action === 'write' ? 'project.write' : 'project.read', projectId, db, { lock: options?.lock }), 'project');
      return { workspaceId: checked.project!.workspaceId, level: accessName(checked.level)! };
    },

    async canUseProject(principal, action, projectId, options) {
      const evaluation = await evaluateProject(principal, action === 'write' ? 'project.write' : 'project.read', projectId, db, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    async requireInvoke(principal, agentId, options) {
      const evaluation = await evaluateAgent(principal, 'agent.invoke', agentId, db, { lock: options?.lock });
      // F-029: the owner's own assistant, refused with its own reason while AI is off in its workspace.
      if (evaluation.visible && evaluation.agent && (await workspaceAi(db, evaluation.agent.workspaceId)).state !== 'allowed') throw new WorkspaceAiBlockedError();
      const { agent } = enforce(evaluation, 'agent');
      return { workspaceId: agent!.workspaceId };
    },

    async canInvoke(principal, agentId, options) {
      const evaluation = await evaluateAgent(principal, 'agent.invoke', agentId, db, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    async canReadSketch(principal, sketchId, options) {
      const evaluation = await evaluateSketch(principal, 'sketch.read', sketchId, db, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    workspaceAi: (workspaceId, options) => workspaceAi(db, workspaceId, options),
    requireWorkspaceAi: (workspaceId, options) => requireWorkspaceAi(db, workspaceId, options),
  };
}
