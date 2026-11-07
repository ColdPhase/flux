import type { PersonalRunAccess } from '../personal-runs/ports.js';
import { accessName, enforce, evaluateAgent, evaluateProject, evaluateSketch, requireSpaceAi } from './policy.js';
import type { AccessReader } from './ports.js';

/**
 * The access policy as the personal-run use cases' `PersonalRunAccess` port (issue #68). It uses
 * the same evaluators as `authorize` and reads current rows on every call; a person-owned agent
 * is capped by its owner's current access there. Pass a reader bound to the unit of work's transaction
 * so `lock` holds until it commits.
 */
export function policyPersonalRunAccess(access: AccessReader): PersonalRunAccess {
  return {
    async requireProject(principal, action, projectId, options) {
      const checked = enforce(await evaluateProject(principal, action === 'write' ? 'project.write' : 'project.read', projectId, access, { lock: options?.lock }), 'project');
      return { workspaceId: checked.project!.workspaceId, level: accessName(checked.level)! };
    },

    async canUseProject(principal, action, projectId, options) {
      const evaluation = await evaluateProject(principal, action === 'write' ? 'project.write' : 'project.read', projectId, access, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    async requireInvoke(principal, agentId, options) {
      const evaluation = await evaluateAgent(principal, 'agent.invoke', agentId, access, { lock: options?.lock });
      const { agent } = enforce(evaluation, 'agent');
      return { workspaceId: agent!.workspaceId };
    },

    async canInvoke(principal, agentId, options) {
      const evaluation = await evaluateAgent(principal, 'agent.invoke', agentId, access, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    async canReadSketch(principal, sketchId, options) {
      const evaluation = await evaluateSketch(principal, 'sketch.read', sketchId, access, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    spaceAi: (projectId, options) => access.spaceAi(projectId, options),
    requireSpaceAi: (projectId, options) => requireSpaceAi(access, projectId, options),
  };
}
