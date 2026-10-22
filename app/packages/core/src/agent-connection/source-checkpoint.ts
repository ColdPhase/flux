import { AGENT_SOURCE_KINDS, type AgentSourceCheckpoint } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

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
