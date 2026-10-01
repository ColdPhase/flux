import { createHash } from 'node:crypto';
import { WORK_READ_LIMITS, type WorkPage, type WorkReadCursor } from '@flux/contracts';
import type { Principal } from '../principal.js';
import { workReadId, workReadInvalid } from './query.js';

export type WorkReadBoundary = WorkReadCursor['boundary'];
export interface KeyedWorkRead<T> { value: T; key: WorkReadBoundary }
export interface WorkReadSlice<T> { items: KeyedWorkRead<T>[]; total: number; before: number; hasBefore: boolean; hasAfter: boolean }

/** Canonical normalized scalar/array/object data only; source sets are digested, never encoded. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function workReadScope(endpoint: string, projectId: string, principal: Principal, selector: unknown, limit: number, objectWindow?: readonly { kind: string; id: string }[]) {
  if (principal.kind === 'fixture' || !principal.id) return workReadInvalid('A signed-in native principal is required');
  return createHash('sha256').update(canonical({ endpoint, projectId: workReadId(projectId), principal: { kind: principal.kind, id: principal.id }, selector, limit, objectWindow })).digest('hex');
}

function boundary(value: unknown): WorkReadBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return workReadInvalid('Invalid read boundary');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'createdAt,id,rank' || !Number.isInteger(raw.rank) || (raw.rank as number) < 0 || (raw.rank as number) > 8) return workReadInvalid('Invalid read boundary');
  // Validate the calendar, but retain the full input string; never use Date as the SQL key.
  if (typeof raw.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(raw.createdAt)) return workReadInvalid('A full-precision native timestamp is required');
  const date = new Date(raw.createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${raw.createdAt.slice(0, 23)}Z`) return workReadInvalid('Invalid native timestamp');
  return { rank: raw.rank as number, createdAt: raw.createdAt, id: workReadId(typeof raw.id === 'string' ? raw.id : undefined) };
}

export function encodeWorkReadCursor(direction: WorkReadCursor['direction'], scope: string, key: WorkReadBoundary): string {
  if (!/^[0-9a-f]{64}$/.test(scope)) return workReadInvalid('Invalid read scope');
  const envelope: WorkReadCursor = { v: 1, direction, scope, boundary: boundary(key) };
  const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  if (encoded.length > WORK_READ_LIMITS.cursor) return workReadInvalid('Read continuation is too large');
  return encoded;
}

export function decodeWorkReadCursor(value: string | undefined, scope: string): WorkReadCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > WORK_READ_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(value)) return workReadInvalid('Invalid read continuation');
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return workReadInvalid('Invalid read continuation'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return workReadInvalid('Invalid read continuation');
  const raw = decoded as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'boundary,direction,scope,v' || raw.v !== 1 || (raw.direction !== 'next' && raw.direction !== 'previous') || raw.scope !== scope) return workReadInvalid('Read continuation does not match this scope');
  const envelope: WorkReadCursor = { v: 1, direction: raw.direction, scope, boundary: boundary(raw.boundary) };
  // Reject alternate/duplicate JSON fields, lossy noncanonical encodings and uppercase IDs.
  if (encodeWorkReadCursor(envelope.direction, scope, envelope.boundary) !== value) return workReadInvalid('Invalid read continuation encoding');
  return envelope;
}

/** The repository supplies exact bounded slice facts from one native observation. */
export function presentWorkReadPage<T>(slice: WorkReadSlice<T>, limit: number, scope: string, supplied?: WorkReadCursor): WorkPage<T> {
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_READ_LIMITS.page) return workReadInvalid('Read limit must be 1–100');
  if (slice.items.length > limit || !Number.isSafeInteger(slice.total) || slice.total < 0 || !Number.isSafeInteger(slice.before) || slice.before < 0 || slice.before + slice.items.length > slice.total ||
    typeof slice.hasBefore !== 'boolean' || typeof slice.hasAfter !== 'boolean' ||
    (slice.items.length > 0 && (slice.hasBefore !== (slice.before > 0) || slice.hasAfter !== (slice.before + slice.items.length < slice.total)))) throw new Error('Invalid native bounded read slice');
  const first = slice.items[0]?.key ?? supplied?.boundary;
  const last = slice.items.at(-1)?.key ?? supplied?.boundary;
  return { items: slice.items.map((item) => item.value), total: slice.total, before: slice.before, limit,
    previousCursor: slice.hasBefore && first ? encodeWorkReadCursor('previous', scope, first) : null,
    nextCursor: slice.hasAfter && last ? encodeWorkReadCursor('next', scope, last) : null };
}
