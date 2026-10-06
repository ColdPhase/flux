import { agentProjectObjectRows, coworkUnitRows } from '@flux/db';
import type { AgentGrantDomainChecks } from '../agent-connection/grants.js';

/** Explicit server composition; metadata never grants task execution on its own.
 * For `cowork.request` the target is the SENDER's own unit and the class its actual role; for
 * `cowork.request.claim`/`.respond` it is the RECIPIENT's own unit and its actual role. For `cowork.unit.create`
 * the target is a native task of this project and the class the role of the units it may create. For
 * `cowork.unit.complete`/`.transfer` it is the HOLDER's own unit and its actual role. */
export const coWorkGrantTargetInTransaction: NonNullable<AgentGrantDomainChecks['coordinationTarget']> =
  async (tx, within, command) => {
    if (!command.objectId) return false;
    if (command.operation === 'cowork.unit.create')
      return !!await agentProjectObjectRows(tx).scopeOf('work', command.objectId,
        { workspaceId: within.workspaceId, projectId: within.projectId });
    return ['cowork.claim', 'cowork.renew', 'cowork.release', 'cowork.request', 'cowork.request.claim', 'cowork.request.respond',
      'cowork.unit.complete', 'cowork.unit.transfer'].includes(command.operation)
      && await coworkUnitRows(tx).grantTarget({ ...within, unitId: command.objectId }, command.peerRequestClass);
  };
