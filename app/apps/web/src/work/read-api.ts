import {
  projectWorkAssociationsPath, projectWorkDetailPath, projectWorkRelationsPath,
  projectWorkSummaryPath, projectWorkViewPath,
  type ProjectWorkSummary, type ProjectWorkView, type ProjectWorkViewQuery,
  type WorkAssociationQuery, type WorkAssociations, type WorkDetailProjection,
  type WorkObjectType, type WorkRelationQuery, type WorkRelations,
} from '@flux/contracts';
import { request } from '../api/client.js';

// These GETs return explicit bounded projections. Never adapt a page to ProjectWork,
// concatenate continuations, or use an unavailable read as an empty collection.
function withQuery(path: string, fields: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `${path}?${query}`;
}

/** Canonical selector URLs are also client request-scope keys; cursors remain opaque. */
export function workViewReadUrl(projectId: string, query: ProjectWorkViewQuery = {}) {
  const path = projectWorkViewPath(encodeURIComponent(projectId));
  const window = { limit: query.limit ?? 50, cursor: query.cursor };
  if (query.purpose !== 'choices') {
    return withQuery(path, { purpose: 'tasks', group: query.group ?? 'all', mine: query.mine ?? false, ...window });
  }
  const selector = { purpose: 'choices', choice: query.choice, q: query.q?.trim() || undefined, ...window };
  switch (query.choice) {
    case 'accepted_decisions':
    case 'pivot_work': return withQuery(path, selector);
    case 'result_work': return withQuery(path, { ...selector, selected: query.selected });
    case 'parked_work': return withQuery(path, { ...selector, decisionId: query.decisionId });
    case 'doc_refs': return withQuery(path, { ...selector, kind: query.kind });
  }
}

function boundedSet(value: string, name: string) {
  const values = value.split(',');
  // Check the raw input bound before deduplicating, just as the public contract does.
  if (!value || values.length > 100 || values.some((part) => !part)) throw new Error(`${name} requires 1–100 references`);
  return [...new Set(values)].sort().join(',');
}

export function workAssociationReadUrl(projectId: string, query: WorkAssociationQuery) {
  return withQuery(projectWorkAssociationsPath(encodeURIComponent(projectId)), {
    relation: query.relation ?? 'source', limit: query.limit ?? 50,
    cursor: query.cursor, edgeCursor: query.edgeCursor,
    ...(query.messageIds !== undefined
      ? { messageIds: boundedSet(query.messageIds, 'Messages') }
      : { conversationId: query.conversationId, sourceCursor: query.sourceCursor }),
  });
}

export function workRelationReadUrl(projectId: string, query: WorkRelationQuery) {
  return withQuery(projectWorkRelationsPath(encodeURIComponent(projectId)), {
    objects: boundedSet(query.objects, 'Objects'), role: query.role,
    limit: query.limit ?? 50, cursor: query.cursor,
  });
}

export const getProjectWorkSummary = (projectId: string, signal?: AbortSignal) =>
  request<ProjectWorkSummary>(projectWorkSummaryPath(encodeURIComponent(projectId)), { signal });
export const getProjectWorkView = (projectId: string, query: ProjectWorkViewQuery = {}, signal?: AbortSignal) =>
  request<ProjectWorkView>(workViewReadUrl(projectId, query), { signal });
export const getWorkAssociations = (projectId: string, query: WorkAssociationQuery, signal?: AbortSignal) =>
  request<WorkAssociations>(workAssociationReadUrl(projectId, query), { signal });
export const getWorkRelations = (projectId: string, query: WorkRelationQuery, signal?: AbortSignal) =>
  request<WorkRelations>(workRelationReadUrl(projectId, query), { signal });
export const getWorkDetail = (projectId: string, kind: WorkObjectType, id: string, signal?: AbortSignal) =>
  request<WorkDetailProjection>(projectWorkDetailPath(encodeURIComponent(projectId), kind, encodeURIComponent(id)), { signal });
