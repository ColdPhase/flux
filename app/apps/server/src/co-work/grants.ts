import { coworkUnitRows } from '@flux/db';
import type { AgentGrantDomainChecks } from '../agent-connection/grants.js';

/** Explicit server composition; metadata never grants task execution on its own.
 * For `cowork.request` the target is the SENDER's own unit and the class its actual role; for
 * `cowork.request.claim`/`.respond` it is the RECIPIENT's own unit and its actual role. */
export const coWorkGrantTargetInTransaction: NonNullable<AgentGrantDomainChecks['coordinationTarget']> =
  async (tx, within, command) => !!command.objectId && ['cowork.claim', 'cowork.renew', 'cowork.release', 'cowork.request',
    'cowork.request.claim', 'cowork.request.respond'].includes(command.operation)
    && await coworkUnitRows(tx).grantTarget({ ...within, unitId: command.objectId }, command.peerRequestClass);
