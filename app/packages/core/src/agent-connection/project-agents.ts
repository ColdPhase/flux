import type { ProjectAgents } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../principal.js';

/**
 * The Agents view of one project (UI116-2, #136). The adapter checks the reader's current
 * project access and lists only connections that can act there now: selected for the project,
 * unrevoked, with an unrevoked agent that still has project access and an owner who still does.
 */
export interface ProjectAgentsPort {
  list(reader: Principal & { kind: 'human' }, projectId: string): Promise<ProjectAgents>;
}

export function projectAgentUseCases(port: ProjectAgentsPort) {
  return {
    list(principal: Principal, projectId: string): Promise<ProjectAgents> {
      if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person is required');
      if (!isUuid(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      return port.list(principal as Principal & { kind: 'human' }, projectId);
    },
  };
}
