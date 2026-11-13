import { AGENT_MAY_DO, type AgentConnection, type AgentMayDo, type UpdateAgentConnectionCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../types.js';

export interface AgentConnectionPort {
  list(ownerUserId: string): Promise<AgentConnection[]>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
  resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null>;
  /** The owner's own unrevoked connection only; null for anyone else's or a revoked one. */
  setMayDo(ownerUserId: string, connectionId: string, mayDo: AgentMayDo): Promise<AgentConnection | null>;
}

function personId(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

export function agentConnectionUseCases(port: AgentConnectionPort) {
  return {
    list(principal: Principal): Promise<AgentConnection[]> { return port.list(personId(principal)); },
    /**
     * Ask me first (F-036 AG-3): only the owner, in their own signed-in session, changes it. The HTTP route takes a browser
     * session only, so no agent, run token or MCP client reaches it, not even for itself.
     */
    async update(principal: Principal, id: string, input: UpdateAgentConnectionCommand): Promise<AgentConnection> {
      if (!isUuid(id)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'mayDo') || !AGENT_MAY_DO.includes(input.mayDo))
        throw new InvalidInputError('Turn Ask me first on or off');
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
