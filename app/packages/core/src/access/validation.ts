import type { DraftVisibility, PageQuery, ProjectGrantRole, ProjectVisibility, WorkspaceRole } from '@flux/contracts';
import { InvalidInputError } from './errors.js';

// Input validators shared by the workspace, project, agent and draft use cases (issues #46, #91).
// They throw `InvalidInputError` before a transaction opens, so a bad request never takes a lock.

export const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];
export const PROJECT_VISIBILITIES: readonly ProjectVisibility[] = ['workspace', 'restricted'];
export const GRANT_ROLES: readonly ProjectGrantRole[] = ['contributor', 'viewer', 'denied'];
export const DRAFT_VISIBILITIES: readonly DraftVisibility[] = ['private', 'project', 'workspace'];
const MAX_BODY = 100_000;

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new InvalidInputError(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

export function name(value: unknown, field = 'Name'): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 200) throw new InvalidInputError(`${field} must be 1–200 characters`);
  return text;
}

export function body(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_BODY) throw new InvalidInputError(`Body must be a string of at most ${MAX_BODY} characters`);
  return value;
}

export function parsePage(query: PageQuery = {}): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}
