import { coworkUnitRows } from '@flux/db';
import type { AgentGrantDomainChecks } from '../agent-connection/grants.js';

/** Explicit server composition; metadata never grants task execution on its own. */
export const coWorkGrantTargetInTransaction: NonNullable<AgentGrantDomainChecks['coordinationTarget']> =
  async (tx, within, command) => !!command.objectId && ['cowork.claim', 'cowork.renew', 'cowork.release'].includes(command.operation)
    && await coworkUnitRows(tx).grantTarget({ ...within, unitId: command.objectId }, command.peerRequestClass);
