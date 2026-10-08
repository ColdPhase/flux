import { idpStandingRepository } from '@flux/db';
import type { Executor } from '../types.js';
import type { PersonalRunAccess } from '../personal-runs/ports.js';
import { accessName, enforce, evaluateAgent, evaluateProject, evaluateSketch } from './policy.js';

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
      const { agent } = enforce(await evaluateAgent(principal, 'agent.invoke', agentId, db, { lock: options?.lock }), 'agent');
      return { workspaceId: agent!.workspaceId };
    },

    async canInvoke(principal, agentId, options) {
      // A person whose account no longer stands at the identity provider starts and continues no compute (F-024 S4, #311).
      if (principal.kind === 'human' && await idpStandingRepository(db).refuses(principal.id)) return false;
      const evaluation = await evaluateAgent(principal, 'agent.invoke', agentId, db, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },

    async canReadSketch(principal, sketchId, options) {
      const evaluation = await evaluateSketch(principal, 'sketch.read', sketchId, db, { lock: options?.lock });
      return evaluation.visible && evaluation.allowed;
    },
  };
}
