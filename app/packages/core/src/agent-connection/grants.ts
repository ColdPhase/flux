import { AGENT_OPERATIONS, AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES,
  type AgentStandingGrant, type CreateAgentStandingGrantCommand, type Page, type PageQuery } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import { parsePage } from '../access/domain.js';
import type { Principal } from '../principal.js';

export interface AgentStandingGrantPort {
  create(ownerUserId: string, connectionId: string, command: CreateAgentStandingGrantCommand): Promise<AgentStandingGrant>;
  list(ownerUserId: string, connectionId: string, page: { limit: number; offset: number }): Promise<Page<AgentStandingGrant>>;
  revoke(ownerUserId: string, connectionId: string, grantId: string): Promise<void>;
}
function owner(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in connection owner is required');
  return principal.id;
}
function id(value: unknown): string {
  if (!isUuid(value)) throw new NotFoundError('Connection or grant', 'GRANT_NOT_FOUND');
  return value.toLowerCase();
}
export function normalizeStandingGrant(command: CreateAgentStandingGrantCommand): CreateAgentStandingGrantCommand {
  if (!command || Object.keys(command).some((key) => !['clientCommandId', 'projectId', 'operation', 'peerRequestClass', 'objectId', 'maximumUses', 'expiresAt'].includes(key))
    || !isUuid(command.clientCommandId)
    || !isUuid(command.projectId) || !AGENT_OPERATIONS.includes(command.operation)
    || !AGENT_PEER_REQUEST_CLASSES.includes(command.peerRequestClass)
    || !AGENT_OPERATION_CLASSES[command.operation].includes(command.peerRequestClass)
    || command.objectId !== undefined && !isUuid(command.objectId)
    || !Number.isSafeInteger(command.maximumUses) || command.maximumUses < 1 || command.maximumUses > 1000
    || typeof command.expiresAt !== 'string' || command.expiresAt.length > 40 || !Number.isFinite(Date.parse(command.expiresAt)))
    throw new InvalidInputError('An exact operation, class, selected project, optional object, use limit and expiry are required');
  return { clientCommandId: command.clientCommandId.toLowerCase(), projectId: command.projectId.toLowerCase(), operation: command.operation, peerRequestClass: command.peerRequestClass,
    ...(command.objectId ? { objectId: command.objectId.toLowerCase() } : {}), maximumUses: command.maximumUses,
    expiresAt: new Date(command.expiresAt).toISOString() };
}
/** All owner entry points share exact validation; the adapter rechecks current project management. */
export function agentStandingGrantUseCases(port: AgentStandingGrantPort) {
  return {
    create(principal: Principal, connectionId: string, command: CreateAgentStandingGrantCommand) {
      return port.create(owner(principal), id(connectionId), normalizeStandingGrant(command));
    },
    list(principal: Principal, connectionId: string, query?: PageQuery) {
      const page = parsePage(query);
      if (page.limit > 50) throw new InvalidInputError('At most 50 grants can be read at once');
      return port.list(owner(principal), id(connectionId), page);
    },
    revoke(principal: Principal, connectionId: string, grantId: string) {
      return port.revoke(owner(principal), id(connectionId), id(grantId));
    },
  };
}
