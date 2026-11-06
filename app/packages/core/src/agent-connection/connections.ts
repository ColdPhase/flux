import { AGENT_MAY_DO, type AgentConnection, type AgentMayDo, type AgentScope, type CreateAgentConnectionCommand, type UpdateAgentConnectionCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../types.js';

export interface AgentConnectionPort {
  create(ownerUserId: string, command: CreateAgentConnectionCommand): Promise<AgentConnection | 'AGENT_NOT_FOUND'>;
  list(ownerUserId: string): Promise<AgentConnection[]>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
  resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null>;
  /** The owner's own unrevoked connection only; null for anyone else's or a revoked one. */
  setMayDo(ownerUserId: string, connectionId: string, mayDo: AgentMayDo): Promise<AgentConnection | null>;
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
    /**
     * "What it may do" (F-036 AG-3): only the owner, in their own signed-in session, changes it. The HTTP route takes a browser
     * session only, so no agent, run token or MCP client reaches it, not even for itself.
     */
    async update(principal: Principal, id: string, input: UpdateAgentConnectionCommand): Promise<AgentConnection> {
      if (!isUuid(id)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'mayDo') || !AGENT_MAY_DO.includes(input.mayDo))
        throw new InvalidInputError('Choose Only read, Do it and tell me, or Ask me first');
      const updated = await port.setMayDo(personId(principal), id, input.mayDo);
      if (!updated) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      return updated;
    },
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
