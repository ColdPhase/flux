import type { SearchKind, SearchText } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of search (issue #114, foundation 8.12). Core states what it needs; the server implements
 * them with the access policy (`visibleFilter`, `authorize`) and the `@flux/db` rows. Nothing in
 * `packages/core/src/search` imports those adapters. `C` is the adapter's condition type (SQL):
 * core passes it through without looking inside.
 */

/** The object that carries the permission of a search row. */
export type SearchAudienceType = 'project' | 'dm' | 'sketch' | 'draft' | 'members';

/** Audiences of one type in one workspace that the principal may read now, as the policy's list condition. */
export interface SearchAudience<C> {
  type: SearchAudienceType;
  workspaceId: string;
  condition: C | null;
}

export interface SearchAccess<C> {
  /** Every audience the principal may read now, across the workspaces they are active in. Fresh on every call. */
  audiences(principal: Principal): Promise<SearchAudience<C>[]>;
}

/** Where a page ended: the last visible result's rank, time and row. Only ever sent sealed. */
export interface SearchPosition { score: string; at: string; id: string }

export interface SearchPlan {
  text: string;
  prefix: string | null;
  fuzzy: boolean;
  /** The plain words of the prefix query (letters and digits), also looked up in the index. */
  words: string;
  kinds: SearchKind[] | null;
  place: { type: 'project' | 'dm'; id: string } | { type: 'private' } | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
  after: SearchPosition | null;
  limit: number;
  reader: string;
}

export interface SearchRow {
  position: SearchPosition;
  kind: SearchKind;
  workspaceId: string;
  workspaceName: string | null;
  objectId: string;
  parentId: string | null;
  projectId: string | null;
  projectName: string | null;
  /** The DM of a DM message, or of a sketch or thought that belongs to a DM (#96). */
  dmId: string | null;
  dmName: string | null;
  sketchTitle: string | null;
  version: number | null;
  currentVersion: number | null;
  status: string | null;
  title: SearchText;
  snippet: SearchText | null;
  hasBody: boolean;
  authorName: string | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
  at: Date;
}

/** What the statements of a search read (EXPLAIN ANALYZE, BUFFERS): test support. */
export interface SearchWork {
  /** Table rows read by scan nodes, including rows a filter discarded. */
  rows: number;
  /** Row addresses produced by the search index scans. */
  indexRows: number;
  /** Buffers read by the scans of the search table and its index, index pages included. */
  searchBuffers: number;
  /** Buffers of the whole statements. */
  buffers: number;
  /** Index scans on the search table, and the index keys each one looks up. */
  indexScans: number;
  lookups: number;
  nodes: string[];
}

/** Rows only; every statement composes the audiences' conditions before ranking, limit and counts. */
export interface SearchRepository<C> {
  page(audiences: SearchAudience<C>[], plan: SearchPlan): Promise<SearchRow[]>;
  counts(audiences: SearchAudience<C>[], plan: SearchPlan, cap: number): Promise<{ counts: Map<SearchKind, number>; capped: boolean }>;
  /** Test support: rows examined by the statements of a plan. */
  explain(audiences: SearchAudience<C>[], plan: SearchPlan, cap: number): Promise<SearchWork>;
}

/** Seals a position to one principal and one query; anything else opens to null. */
export interface SearchCursors {
  seal(principal: Principal, scope: string, position: SearchPosition): string;
  open(principal: Principal, scope: string, token: string): SearchPosition | null;
}

export interface SearchPorts<C> {
  access: SearchAccess<C>;
  rows: SearchRepository<C>;
  cursors: SearchCursors;
}
