import type { AgentConnection, AgentScope, CreateAgentConnectionCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../types.js';

export interface AgentConnectionPort {
  create(ownerUserId: string, command: CreateAgentConnectionCommand): Promise<AgentConnection | 'AGENT_NOT_FOUND'>;
  list(ownerUserId: string): Promise<AgentConnection[]>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
  resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null>;
}

const SCOPES: readonly AgentScope[] = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];

/** Consent selects a ceiling; it cannot create an agent or project grant. */
export function validateConnectionCommand(input: CreateAgentConnectionCommand): CreateAgentConnectionCommand {
  if (!input || !isUuid(input.agentId)) throw new InvalidInputError('agentId must be a UUID');
  if (!Array.isArray(input.selectedProjectIds) || !input.selectedProjectIds.length || input.selectedProjectIds.length > 50
    || input.selectedProjectIds.some((id) => !isUuid(id))
    || new Set(input.selectedProjectIds).size !== input.selectedProjectIds.length)
    throw new InvalidInputError('Select 1–50 distinct project IDs');
  if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > SCOPES.length
    || input.scopes.some((scope) => !SCOPES.includes(scope))
    || new Set(input.scopes).size !== input.scopes.length)
    throw new InvalidInputError('Select distinct supported connection scopes');
  const name = input.name === undefined ? 'External connection' : typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120)
    throw new InvalidInputError('Connection name must be 1–120 characters');
  const clientDesignation = input.clientDesignation ?? 'other';
  if (!['claude_code', 'codex', 'other'].includes(clientDesignation)) throw new InvalidInputError('Select a supported client designation');
  return { agentId: input.agentId, selectedProjectIds: [...input.selectedProjectIds], scopes: [...input.scopes], name, clientDesignation };
}

function personId(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

export function agentConnectionUseCases(port: AgentConnectionPort) {
  return {
    async create(principal: Principal, input: CreateAgentConnectionCommand): Promise<AgentConnection> {
      const result = await port.create(personId(principal), validateConnectionCommand(input));
      if (result === 'AGENT_NOT_FOUND') throw new NotFoundError('Agent', result);
      return result;
    },
    list(principal: Principal): Promise<AgentConnection[]> { return port.list(personId(principal)); },
    async revoke(principal: Principal, id: string): Promise<void> {
      if (!isUuid(id)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      if (!await port.revoke(personId(principal), id)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
    },
    /** The OAuth token's `sub` must match the selection owner; revocation is checked live. */
    async resolveForToken(ownerUserId: string, connectionId: string): Promise<AgentConnection> {
      if (!ownerUserId || !isUuid(connectionId)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      const connection = await port.resolve(ownerUserId, connectionId);
      if (!connection) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      return connection;
    },
  };
}
