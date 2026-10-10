import { AGENT_MCP_ENTRIES, type AgentConnection, type AgentMcpCapabilityId, type AgentMcpEntry, type AgentMcpPolicy,
  type SaveAgentMcpPolicy, type AgentConnectionSetupFacts } from '@flux/contracts';
import { DomainError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../types.js';

export interface AgentMcpPolicyPort {
  get(ownerUserId: string, connectionId: string): Promise<{ connection: AgentConnection; policy: AgentMcpPolicy } | null>;
  save(ownerUserId: string, connectionId: string, expectedVersion: number, input: SaveAgentMcpPolicy):
    Promise<AgentMcpPolicy | 'CONNECTION_NOT_FOUND' | 'POLICY_VERSION_CONFLICT' | 'MCP_POLICY_OUTSIDE_CONSENT' | 'MCP_POLICY_AUTHORITY_UNAVAILABLE'>;
}

/** Owner-only factual projection. It grants no authority and never certifies native activation. */
export interface AgentConnectionSetupPort {
  get(connection: AgentConnection): Promise<AgentConnectionSetupFacts>;
}

/** A request cannot adopt a policy saved after it was admitted, even after Off then On. */
export function requireAgentMcpEntry(policy: AgentMcpPolicy, capturedVersion: number, entry: AgentMcpEntry,
  capabilities: Iterable<AgentMcpCapabilityId> = entry.requiredCapabilities): void {
  if (!Number.isInteger(capturedVersion) || capturedVersion < 1 || policy.version !== capturedVersion
    || !policy.enabledEntryIds.includes(entry.id)
    || [...entry.requiredCapabilities, ...capabilities].some((id) => !policy.enabledCapabilityIds.includes(id)))
    throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
}

/** Exact registered membership and the original scopes define the ceiling, including for aliases. */
export function initialAgentMcpPolicy(connection: AgentConnection): AgentMcpPolicy {
  const entries = AGENT_MCP_ENTRIES.filter((entry) => connection.scopes.includes(entry.requiredScope));
  return { connectionId: connection.id, version: 1, selectedProjectIds: [...connection.selectedProjectIds].sort(),
    enabledEntryIds: entries.map((entry) => entry.id).sort(),
    enabledCapabilityIds: [...new Set(entries.flatMap((entry) => entry.requiredCapabilities))].sort() };
}

export function validateMcpPolicy(input: SaveAgentMcpPolicy): SaveAgentMcpPolicy {
  const uniqueStrings = (value: unknown, limit: number): value is string[] => Array.isArray(value)
    && value.length <= limit && value.every((item) => typeof item === 'string') && new Set(value).size === value.length;
  const capabilities = new Set(AGENT_MCP_ENTRIES.flatMap((entry) => entry.requiredCapabilities));
  const entries = new Set(AGENT_MCP_ENTRIES.map((entry) => entry.id));
  if (!input || !uniqueStrings(input.enabledCapabilityIds, 128)
    || input.enabledCapabilityIds.some((id) => !capabilities.has(id as AgentMcpCapabilityId))
    || !uniqueStrings(input.enabledEntryIds, 256) || input.enabledEntryIds.some((id) => !entries.has(id))
    || !uniqueStrings(input.selectedProjectIds, 50) || input.selectedProjectIds.some((id) => !isUuid(id)))
    throw new InvalidInputError('Select distinct supported permissions and projects');
  return { enabledCapabilityIds: [...input.enabledCapabilityIds].sort(), enabledEntryIds: [...input.enabledEntryIds].sort(),
    selectedProjectIds: [...input.selectedProjectIds].sort() };
}

export function mcpPolicyWithinConsent(connection: AgentConnection, input: SaveAgentMcpPolicy): boolean {
  const ceiling = initialAgentMcpPolicy(connection);
  return input.enabledCapabilityIds.every((id) => ceiling.enabledCapabilityIds.includes(id))
    && input.enabledEntryIds.every((id) => ceiling.enabledEntryIds.includes(id))
    && input.selectedProjectIds.every((id) => connection.selectedProjectIds.includes(id));
}

/** Admit only the newly configured authority, never an unrelated retained-but-unavailable effect. */
export function mcpPolicyAdmissionActions(previous: AgentMcpPolicy, input: SaveAgentMcpPolicy):
  { projectId: string; action: 'project.read' | 'project.write' }[] {
  const capabilities = input.enabledCapabilityIds.filter((id) => !previous.enabledCapabilityIds.includes(id));
  const entries = AGENT_MCP_ENTRIES.filter((entry) => input.enabledEntryIds.includes(entry.id)
    && entry.requiredCapabilities.every((id) => input.enabledCapabilityIds.includes(id)));
  const addedEntries = entries.filter((entry) => !previous.enabledEntryIds.includes(entry.id));
  const widened = capabilities.length > 0 || addedEntries.length > 0;
  const writes = capabilities.some((id) => !id.endsWith('.read'))
    || addedEntries.some((entry) => entry.requiredScope !== 'flux.context.read');
  return input.selectedProjectIds.flatMap((projectId) => {
    const addedProject = !previous.selectedProjectIds.includes(projectId);
    if (!widened && !addedProject) return [];
    const needsWrite = writes || (addedProject && entries.some((entry) => entry.requiredScope !== 'flux.context.read'));
    return [{ projectId, action: needsWrite ? 'project.write' as const : 'project.read' as const }];
  }).sort((a, b) => a.projectId.localeCompare(b.projectId));
}

const owner = (principal: Principal, connectionId: string) => {
  if (principal.kind !== 'human' || !isUuid(connectionId)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
  return principal.id;
};

export function agentMcpPolicyUseCases(port: AgentMcpPolicyPort) {
  return {
    async get(principal: Principal, connectionId: string) {
      const result = await port.get(owner(principal, connectionId), connectionId);
      if (!result) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
      return result;
    },
    async save(principal: Principal, connectionId: string, expectedVersion: number, input: SaveAgentMcpPolicy) {
      const ownerId = owner(principal, connectionId);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= 2_147_483_647)
        throw new DomainError(409, 'POLICY_VERSION_CONFLICT', 'Reload these permissions before saving');
      const result = await port.save(ownerId, connectionId, expectedVersion, validateMcpPolicy(input));
      if (result === 'CONNECTION_NOT_FOUND') throw new NotFoundError('Connection', result);
      if (result === 'POLICY_VERSION_CONFLICT') throw new DomainError(409, result, 'These permissions changed; reload before saving');
      if (result === 'MCP_POLICY_OUTSIDE_CONSENT') throw new DomainError(403, result, 'These permissions require explicit connection authorization');
      if (result === 'MCP_POLICY_AUTHORITY_UNAVAILABLE') throw new DomainError(403, result, 'Current project access does not allow these permissions');
      return result;
    },
  };
}
