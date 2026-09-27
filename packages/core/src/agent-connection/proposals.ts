import { createHash } from 'node:crypto';
import type { AgentScope, CreateAgentProposalCommand } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { AgentProposal, Page, PageQuery } from '@flux/contracts';
import { parsePage } from '../access/domain.js';
import type { Principal } from '../types.js';

export type { AgentScope } from '@flux/contracts';

/** Verified OAuth selection. The transport constructs this from live consent, never tool input. */
export interface AgentConnectionContext {
  connectionId: string;
  ownerUserId: string;
  agentId: string;
  selectedProjectIds: readonly string[];
  scopes: readonly AgentScope[];
  computeSource: 'user_operated_claude_code';
}

export function requireAgentSelection(context: AgentConnectionContext, projectId: string, scope: AgentScope): void {
  if (!isUuid(context.connectionId)) throw new NotFoundError('Connection', 'CONNECTION_NOT_FOUND');
  if (!context.scopes.includes(scope)) throw new ForbiddenError('The connection lacks the required scope', 'MCP_SCOPE_REQUIRED');
  if (!isUuid(projectId) || !context.selectedProjectIds.includes(projectId))
    throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InvalidInputError(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 10_000) throw new InvalidInputError(`${field} must be 1–10000 characters`);
  return trimmed;
}

/** Normalization and fingerprint are shared by first write and every retry. */
export function validateProposalCommand(input: CreateAgentProposalCommand): CreateAgentProposalCommand & { fingerprint: string } {
  if (!input || typeof input !== 'object') throw new InvalidInputError('A proposal command is required');
  if (!isUuid(input.projectId) || !isUuid(input.source?.materialId) || !isUuid(input.clientCommandId))
    throw new InvalidInputError('projectId, source.materialId and clientCommandId must be UUIDs');
  if (!Number.isInteger(input.source.version) || input.source.version < 1 || input.source.version > 2_147_483_647)
    throw new InvalidInputError('source.version must be a positive PostgreSQL integer');
  const normalized = {
    projectId: input.projectId,
    source: { materialId: input.source.materialId, version: input.source.version },
    clientCommandId: input.clientCommandId,
    fact: boundedText(input.fact, 'fact'),
    interpretation: boundedText(input.interpretation, 'interpretation'),
    suggestedAction: boundedText(input.suggestedAction, 'suggestedAction'),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { ...normalized, fingerprint };
}

export type ProposalPersistenceError = 'CONNECTION_NOT_FOUND' | 'AGENT_NOT_FOUND' | 'MATERIAL_NOT_FOUND' | 'SOURCE_VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
export interface AgentProposalPort {
  create(connection: AgentConnectionContext, command: ReturnType<typeof validateProposalCommand>): Promise<AgentProposal | ProposalPersistenceError>;
  listForPerson(principal: Principal, projectId: string, page: { limit: number; offset: number }): Promise<Page<AgentProposal>>;
}

/** Transport-independent checks and error mapping; persistence implements this port. */
export function agentProposalUseCases(port: AgentProposalPort) {
  return {
    async create(connection: AgentConnectionContext, command: CreateAgentProposalCommand): Promise<AgentProposal> {
      const normalized = validateProposalCommand(command);
      requireAgentSelection(connection, normalized.projectId, 'flux.proposal.write');
      const result = await port.create(connection, normalized);
      if (result === 'CONNECTION_NOT_FOUND') throw new NotFoundError('Connection', result);
      if (result === 'AGENT_NOT_FOUND') throw new NotFoundError('Agent', result);
      if (result === 'MATERIAL_NOT_FOUND') throw new NotFoundError('Material', result);
      if (result === 'SOURCE_VERSION_CONFLICT') throw new ConflictError('Source material changed since the selected version', result);
      if (result === 'IDEMPOTENCY_CONFLICT') throw new ConflictError('This clientCommandId was used for another proposal', result);
      return result;
    },
    listForPerson(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<AgentProposal>> {
      if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person is required');
      return port.listForPerson(principal, projectId, parsePage(query));
    },
  };
}
