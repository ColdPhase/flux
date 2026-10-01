import { WORK_GROUPS, WORK_READ_LIMITS, type LinkRole, type WorkGroup, type WorkObjectType } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

/** Normalized read selectors owned by core; transport CSV/query strings never reach SQL. */
export type WorkViewSelection =
  | { purpose: 'tasks'; group: 'all' | WorkGroup; mine: boolean }
  | { purpose: 'choices'; choice: 'accepted_decisions' | 'pivot_work'; q: string }
  | { purpose: 'choices'; choice: 'result_work'; q: string; selected?: string }
  | { purpose: 'choices'; choice: 'parked_work'; q: string; decisionId: string }
  | { purpose: 'choices'; choice: 'doc_refs'; q: string; kind: WorkObjectType };
export interface WorkReadWindow { limit: number; cursor?: string }
export interface WorkViewRead extends WorkReadWindow { selection: WorkViewSelection }
export type WorkAssociationSelection = { relation: 'source' | 'any' } & ({ messageIds: string[] } | { conversationId: string });
export interface WorkAssociationRead extends WorkReadWindow { selection: WorkAssociationSelection; edgeCursor?: string; sourceCursor?: string }
export interface WorkReadObject { kind: WorkObjectType; id: string }
export interface WorkRelationRead extends WorkReadWindow { selection: { objects: WorkReadObject[]; role?: LinkRole } }

export const workReadInvalid = (message: string): never => { throw new InvalidInputError(message, 'INVALID_WORK_READ'); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly WorkObjectType[] = ['work', 'decision', 'result'];
const ROLES: readonly LinkRole[] = ['source', 'affects', 'still_applies', 'about', 'related', 'mentions'];

export function workReadId(value: string | null | undefined): string {
  if (!value || !UUID.test(value)) return workReadInvalid('A native UUID is required');
  return value.toLowerCase();
}
export function workReadKind(value: string | null | undefined): WorkObjectType {
  if (!KINDS.includes(value as WorkObjectType)) return workReadInvalid('A native work, decision or result kind is required');
  return value as WorkObjectType;
}

function closed(query: URLSearchParams, allowed: readonly string[]) {
  for (const key of query.keys()) {
    if (!allowed.includes(key)) workReadInvalid(`Unsupported read field: ${key}`);
    if (query.getAll(key).length !== 1) workReadInvalid(`Read field must appear once: ${key}`);
  }
}
const optionalId = (query: URLSearchParams, key: string) => query.has(key) ? workReadId(query.get(key)) : undefined;
function cursor(query: URLSearchParams, key = 'cursor'): string | undefined {
  if (!query.has(key)) return undefined;
  const value = query.get(key)!;
  if (!value || value.length > WORK_READ_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(value)) return workReadInvalid('Invalid read continuation');
  return value;
}
function window(query: URLSearchParams): WorkReadWindow {
  const raw = query.get('limit');
  const limit = raw === null ? WORK_READ_LIMITS.defaultPage : /^[1-9][0-9]{0,2}$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > WORK_READ_LIMITS.page) return workReadInvalid('Read limit must be 1–100');
  return { limit, ...(query.has('cursor') ? { cursor: cursor(query) } : {}) };
}
function search(query: URLSearchParams) {
  const value = (query.get('q') ?? '').trim();
  if (value.length > WORK_READ_LIMITS.query || value.includes('\0')) return workReadInvalid('Title search must be at most 200 characters without NUL');
  return value;
}
function list(query: URLSearchParams, key: string, maximum: number) {
  const raw = query.get(key);
  if (!raw) return workReadInvalid(`A nonempty ${key} selector is required`);
  const values = raw.split(',');
  if (values.length > maximum) return workReadInvalid(`Too many ${key} entries`);
  return values.map((value) => value.trim());
}

export function assertEmptyWorkReadQuery(query: URLSearchParams) { closed(query, []); }

export function parseWorkViewRead(query: URLSearchParams): WorkViewRead {
  const purpose = query.get('purpose') ?? 'tasks';
  if (purpose === 'tasks') {
    closed(query, ['purpose', 'group', 'mine', 'limit', 'cursor']);
    const group = query.get('group') ?? 'all';
    if (group !== 'all' && !WORK_GROUPS.includes(group as WorkGroup)) return workReadInvalid('Unknown Tasks group');
    const mine = query.get('mine') ?? 'false';
    if (mine !== 'true' && mine !== 'false') return workReadInvalid('mine must be true or false');
    return { ...window(query), selection: { purpose, group: group as 'all' | WorkGroup, mine: mine === 'true' } };
  }
  if (purpose !== 'choices') return workReadInvalid('Unknown read purpose');
  const choice = query.get('choice');
  const base = ['purpose', 'choice', 'q', 'limit', 'cursor'];
  if (choice === 'accepted_decisions' || choice === 'pivot_work') {
    closed(query, base);
    return { ...window(query), selection: { purpose, choice, q: search(query) } };
  }
  if (choice === 'result_work') {
    closed(query, [...base, 'selected']);
    return { ...window(query), selection: { purpose, choice, q: search(query), ...(query.has('selected') ? { selected: optionalId(query, 'selected') } : {}) } };
  }
  if (choice === 'parked_work') {
    closed(query, [...base, 'decisionId']);
    return { ...window(query), selection: { purpose, choice, q: search(query), decisionId: workReadId(query.get('decisionId')) } };
  }
  if (choice === 'doc_refs') {
    closed(query, [...base, 'kind']);
    return { ...window(query), selection: { purpose, choice, q: search(query), kind: workReadKind(query.get('kind')) } };
  }
  return workReadInvalid('Unknown choice selector');
}

export function parseWorkAssociationRead(query: URLSearchParams): WorkAssociationRead {
  const messages = query.has('messageIds');
  const conversation = query.has('conversationId');
  if (messages === conversation) return workReadInvalid('Choose exactly one message or conversation selector');
  closed(query, ['limit', 'cursor', 'edgeCursor', 'relation', ...(messages ? ['messageIds'] : ['conversationId', 'sourceCursor'])]);
  const relation = query.get('relation') ?? 'source';
  if (relation !== 'source' && relation !== 'any') return workReadInvalid('Unknown association meaning');
  const selection: WorkAssociationSelection = messages
    ? { relation, messageIds: [...new Set(list(query, 'messageIds', WORK_READ_LIMITS.sourceIds).map(workReadId))].sort() }
    : { relation, conversationId: workReadId(query.get('conversationId')) };
  return { ...window(query), selection, ...(query.has('edgeCursor') ? { edgeCursor: cursor(query, 'edgeCursor') } : {}),
    ...(query.has('sourceCursor') ? { sourceCursor: cursor(query, 'sourceCursor') } : {}) };
}

export function parseWorkRelationRead(query: URLSearchParams): WorkRelationRead {
  closed(query, ['limit', 'cursor', 'objects', 'role']);
  const unique = new Map<string, WorkReadObject>();
  for (const value of list(query, 'objects', WORK_READ_LIMITS.relationObjects)) {
    const parts = value.split(':');
    if (parts.length !== 2) return workReadInvalid('Expected kind:UUID object reference');
    const ref = { kind: workReadKind(parts[0]), id: workReadId(parts[1]) };
    unique.set(`${ref.kind}:${ref.id}`, ref);
  }
  const role = query.has('role') ? query.get('role') as LinkRole : undefined;
  if (role !== undefined && !ROLES.includes(role)) return workReadInvalid('Unknown native relation role');
  return { ...window(query), selection: { objects: [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref), ...(role ? { role } : {}) } };
}
