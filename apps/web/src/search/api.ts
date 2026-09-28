import { SEARCH_PATH, type SearchFilterType, type SearchResponse, type SearchTarget } from '@flux/contracts';
import { request } from '../api/client';

/** Search across Flux (#114). The server answers only with what the person may open now. */
export interface SearchParams { q: string; type?: SearchFilterType | null; place?: string | null; cursor?: string | null; limit?: number }

export function searchFlux(params: SearchParams, signal?: AbortSignal) {
  const query = new URLSearchParams({ q: params.q });
  if (params.type) query.set('type', params.type);
  if (params.place) query.set('place', params.place);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  return request<SearchResponse>(`${SEARCH_PATH}?${query}`, { signal });
}

/** Where a result opens: the exact message, version, thought or object. */
export function targetHref(target: SearchTarget): string {
  switch (target.type) {
    case 'message': return `/projects/${target.projectId}/conversations/${target.conversationId}#message-${target.messageId}`;
    case 'dm_message': return `/dm/${target.dmId}#message-${target.messageId}`;
    case 'material': return `/materials/${target.materialId}/versions/${target.version}`;
    case 'doc': return `/projects/${target.projectId}/docs/${target.docId}/versions/${target.version}`;
    case 'sketch': return `/map/${target.sketchId}`;
    case 'thought': return `/map/${target.sketchId}#thought-${target.thoughtId}`;
    case 'draft': return `/#draft-${target.draftId}`;
    case 'person': return `/dm/new?workspace=${encodeURIComponent(target.workspaceId)}&with=${encodeURIComponent(target.userId)}`;
    default: return `/projects/${target.projectId}`;
  }
}

/** Work, decisions and results open in Details on their project. */
export function detailsOf(target: SearchTarget) {
  return target.type === 'work' || target.type === 'decision' || target.type === 'result' ? { kind: target.type, id: target.id } : null;
}
