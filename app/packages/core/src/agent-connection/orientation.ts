import { AGENT_SOURCE_KINDS, type AgentSourceChanges, type AgentSourceCheckpoint, type AgentSourceKind,
  type AgentSourcePage, type AgentSourceReference } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import { requireAgentSelection, type AgentConnectionContext } from './proposals.js';

export interface AgentOrientationScope { workspaceId: string; projectId: string }
/** Metadata queries apply exact scope and any canonical provenance policy before projection/count/page. */
export interface AgentOrientationPort {
  list(scope: AgentOrientationScope, kind: AgentSourceKind, page: { limit: number; offset: number }): Promise<{ items: AgentSourceReference[]; total: number }>;
  find(scope: AgentOrientationScope, kind: AgentSourceKind, id: string): Promise<AgentSourceReference | null>;
}
export function agentSourcePage(query: { limit?: number; offset?: number } = {}) {
  const limit = query.limit ?? 20, offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
    throw new InvalidInputError('A source page needs limit 1–50 and offset 0–10000');
  return { limit, offset };
}
export function normalizeAgentCheckpoint(input: AgentSourceCheckpoint): AgentSourceCheckpoint {
  if (!input || !AGENT_SOURCE_KINDS.includes(input.kind) || !isUuid(input.id)) throw new InvalidInputError('A canonical source kind and UUID are required');
  const keys = input.kind === 'result' ? ['kind', 'id'] : input.kind === 'conversation' ? ['kind', 'id', 'sequence']
    : input.kind === 'map' ? ['kind', 'id', 'version', 'updatedAt'] : ['kind', 'id', 'version'];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new InvalidInputError('Unknown checkpoint field');
  const integer = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
  if (input.kind === 'result') return { kind: input.kind, id: input.id.toLowerCase() };
  if (input.kind === 'conversation') {
    if (!integer(input.sequence, 0)) throw new InvalidInputError('A conversation checkpoint needs its latest sequence');
    return { kind: input.kind, id: input.id.toLowerCase(), sequence: input.sequence };
  }
  if (!integer(input.version, 1)) throw new InvalidInputError('A source checkpoint needs its positive canonical version');
  if (input.kind === 'map') {
    if (typeof input.updatedAt !== 'string' || input.updatedAt.length > 40 || !Number.isFinite(Date.parse(input.updatedAt)))
      throw new InvalidInputError('A map checkpoint needs its canonical updatedAt');
    return { kind: input.kind, id: input.id.toLowerCase(), version: input.version, updatedAt: new Date(input.updatedAt).toISOString() };
  }
  return { kind: input.kind, id: input.id.toLowerCase(), version: input.version };
}
function checkedReference(scope: AgentOrientationScope, kind: AgentSourceKind, reference: AgentSourceReference): AgentSourceReference {
  if (reference.workspaceId !== scope.workspaceId || reference.projectId !== scope.projectId || reference.checkpoint.kind !== kind)
    throw new Error('Orientation adapter returned a reference outside its canonical scope');
  return { ...reference, title: reference.title.slice(0, 300), checkpoint: normalizeAgentCheckpoint(reference.checkpoint) };
}
export function agentOrientationUseCases(port: AgentOrientationPort) {
  return {
    async list(connection: AgentConnectionContext, scope: AgentOrientationScope, kind: AgentSourceKind,
      query?: { limit?: number; offset?: number }): Promise<AgentSourcePage> {
      requireAgentSelection(connection, scope.projectId, 'flux.context.read');
      if (!AGENT_SOURCE_KINDS.includes(kind)) throw new InvalidInputError('A canonical source kind is required');
      const page = agentSourcePage(query);
      const result = await port.list(scope, kind, page);
      if (result.items.length > page.limit || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('Invalid orientation page');
      return { projectId: scope.projectId, kind, items: result.items.map((item) => checkedReference(scope, kind, item)),
        total: result.total, ...page, nextOffset: page.offset + page.limit < result.total ? page.offset + page.limit : null,
        coverage: 'canonical_metadata_page' };
    },
    async changes(connection: AgentConnectionContext, scope: AgentOrientationScope, known: AgentSourceCheckpoint[]): Promise<AgentSourceChanges> {
      requireAgentSelection(connection, scope.projectId, 'flux.context.read');
      if (!Array.isArray(known) || known.length > 50) throw new InvalidInputError('At most 50 recorded source checkpoints are accepted');
      const normalized = known.map(normalizeAgentCheckpoint);
      const key = (item: AgentSourceCheckpoint) => `${item.kind}:${item.id}`;
      if (new Set(normalized.map(key)).size !== normalized.length) throw new InvalidInputError('Recorded sources must be distinct');
      const output: AgentSourceChanges = { projectId: scope.projectId, changed: [], unchanged: [], unavailable: [],
        coverage: 'supplied_references_only', newObjectDiscovery: 'use_project_orientation' };
      for (const before of normalized) {
        const found = await port.find(scope, before.kind, before.id);
        const identity = { kind: before.kind, id: before.id };
        if (!found) { output.unavailable.push(identity); continue; }
        const current = checkedReference(scope, before.kind, found);
        if (current.checkpoint.id !== before.id) throw new Error('Orientation adapter returned another source');
        if (JSON.stringify(current.checkpoint) === JSON.stringify(before)) output.unchanged.push(identity);
        else output.changed.push(current);
      }
      return output;
    },
  };
}
