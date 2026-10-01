import { WORK_LIMITS, WORK_STATUSES, type ObjectRef, type PageQuery, type PrincipalRef, type ResultFinding, type TaskPlanIntent, type WorkObjectType, type WorkStatus } from '@flux/contracts';
import { InvalidInputError, PreconditionRequiredError } from '../access/errors.js';
import type { PageWindow } from './ports.js';

// Input rules shared by every entry point of the work use cases (#101). Pure functions.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_TYPES: readonly WorkObjectType[] = ['work', 'decision', 'result'];
export const SOURCE_TYPES: readonly ObjectRef['type'][] = ['message', 'thought', 'material'];
/** Anything in the project a link can reach: sources, work objects, docs (#112) and project sketches. */
export const ANY_TYPES: readonly ObjectRef['type'][] = [...SOURCE_TYPES, ...OBJECT_TYPES, 'doc', 'sketch'];

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function id(value: unknown, label: string): string {
  if (!isId(value)) throw new InvalidInputError(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function title(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > WORK_LIMITS.title) throw new InvalidInputError(`title must be 1–${WORK_LIMITS.title} characters`);
  return trimmed;
}

export function text(value: unknown, label: string, maximum: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum) throw new InvalidInputError(`${label} must be at most ${maximum} characters`);
  return value.trim();
}

export function status(value: unknown): WorkStatus {
  if (typeof value !== 'string' || !(WORK_STATUSES as readonly string[]).includes(value))
    throw new InvalidInputError(`status must be one of ${WORK_STATUSES.join(', ')}`);
  return value as WorkStatus;
}

export function finding(value: unknown): ResultFinding {
  if (value !== 'positive' && value !== 'negative') throw new InvalidInputError('finding must be positive or negative');
  return value;
}

export function owner(value: unknown): PrincipalRef | null {
  if (value === null) return null;
  const ref = value as { kind?: unknown; id?: unknown } | undefined;
  if (!ref || typeof ref !== 'object' || (ref.kind !== 'human' && ref.kind !== 'agent') || typeof ref.id !== 'string' || !ref.id)
    throw new InvalidInputError('owner must be null or { kind: "human" | "agent", id }');
  if (ref.kind === 'agent' && !isId(ref.id)) throw new InvalidInputError('owner.id must be an agent id');
  return { kind: ref.kind, id: ref.kind === 'agent' ? ref.id.toLowerCase() : ref.id };
}

export function ref(value: unknown, allowed: readonly ObjectRef['type'][], label: string): ObjectRef {
  const raw = value as { type?: unknown; id?: unknown; version?: unknown } | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !allowed.includes(raw.type as ObjectRef['type']))
    throw new InvalidInputError(`${label} must reference one of ${allowed.join(', ')}`);
  const refId = id(raw.id, `${label}.id`);
  if (raw.type === 'material') {
    if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1)
      throw new InvalidInputError(`${label}.version must pin a material version`);
    return { type: 'material', id: refId, version: raw.version };
  }
  if (raw.version !== undefined) throw new InvalidInputError(`${label}.version applies to materials only`);
  return { type: raw.type as Exclude<ObjectRef['type'], 'material'>, id: refId };
}

export function refKey(value: ObjectRef): string {
  return value.type === 'material' ? `material:${value.id}:${value.version}` : `${value.type}:${value.id}`;
}

export function refs(value: unknown, allowed: readonly ObjectRef['type'][], label: string): ObjectRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORK_LIMITS.links) throw new InvalidInputError(`${label} must be a list of at most ${WORK_LIMITS.links} references`);
  const unique = new Map<string, ObjectRef>();
  value.forEach((item, index) => { const parsed = ref(item, allowed, `${label}[${index}]`); unique.set(refKey(parsed), parsed); });
  return [...unique.values()];
}

export function ids(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORK_LIMITS.links) throw new InvalidInputError(`${label} must be a list of at most ${WORK_LIMITS.links} ids`);
  return [...new Set(value.map((item, index) => id(item, `${label}[${index}]`)))];
}

/**
 * Task criteria (#152): a list of at most 20 statements, each trimmed to 1-1,000 characters, in the
 * order given with exact duplicates dropped. More than 20 entries is refused, never truncated.
 */
export function criteria(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORK_LIMITS.criteria) throw new InvalidInputError(`criteria must be a list of at most ${WORK_LIMITS.criteria} statements`);
  const unique = new Set<string>();
  value.forEach((item, index) => {
    const statement = typeof item === 'string' ? item.trim() : '';
    if (!statement || statement.length > WORK_LIMITS.criterion) throw new InvalidInputError(`criteria[${index}] must be 1–${WORK_LIMITS.criterion} characters`);
    unique.add(statement);
  });
  return [...unique];
}

/** Prerequisite task ids (#152): at most 50 distinct UUIDs, lowercase and ascending. */
export function dependencyIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORK_LIMITS.dependencies) throw new InvalidInputError(`dependencyIds must be a list of at most ${WORK_LIMITS.dependencies} task ids`);
  return [...new Set(value.map((item, index) => id(item, `dependencyIds[${index}]`)))].sort();
}

/** The plan revision a task is created for (#152): a material, its exact version and a trimmed key. */
export function planIntent(value: unknown): TaskPlanIntent | null {
  if (value === undefined || value === null) return null;
  const raw = value as { materialId?: unknown; version?: unknown; intentKey?: unknown };
  const keys = typeof value === 'object' ? Object.keys(value) : [];
  if (typeof value !== 'object' || Array.isArray(value) || keys.some((key) => !['materialId', 'version', 'intentKey'].includes(key)))
    throw new InvalidInputError('planIntent must be null or { materialId, version, intentKey }');
  const materialId = id(raw.materialId, 'planIntent.materialId');
  if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1)
    throw new InvalidInputError('planIntent.version must be a positive integer');
  const intentKey = typeof raw.intentKey === 'string' ? raw.intentKey.trim() : '';
  if (!intentKey || intentKey.length > WORK_LIMITS.intentKey) throw new InvalidInputError(`planIntent.intentKey must be 1–${WORK_LIMITS.intentKey} characters`);
  return { materialId, version: raw.version, intentKey };
}

/** The version the caller last saw, from If-Match or `expectedVersion`; required for changes. */
export function expectedVersion(value: unknown): number {
  if (value === undefined || value === null) throw new PreconditionRequiredError();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
  return value;
}

export function page(query: PageQuery = {}): PageWindow {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}
