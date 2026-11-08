import { SEARCH_PATH, type SearchResponse, type SearchTarget } from '@flux/contracts';
import { request } from '../api/client';
import { noteLockedWorkspaces } from '../encryption/api';

/** Search across Flux (#114). The server answers only with what the person may open now. `place` narrows a read to one space (the Create window's look for a duplicate). */
export interface SearchParams { q: string; place?: string | null; limit?: number }

export function searchFlux(params: SearchParams, signal?: AbortSignal) {
  const query = new URLSearchParams({ q: params.q });
  if (params.place) query.set('place', params.place);
  if (params.limit) query.set('limit', String(params.limit));
  // F-030: an encrypted space locked here is left out and named (`lockedWorkspaces`); the shell shows it as waiting.
  return request<SearchResponse>(`${SEARCH_PATH}?${query}`, { signal }).then(noteLockedWorkspaces);
}

/** Where a result opens: the exact message, version, thought or object. */
export function targetHref(target: SearchTarget): string {
  switch (target.type) {
    case 'project': return `/projects/${target.projectId}`;
    case 'message': return `/projects/${target.projectId}/conversations/${target.conversationId}#message-${target.messageId}`;
    case 'dm_message': return `/dm/${target.dmId}#message-${target.messageId}`;
    case 'material': return `/materials/${target.materialId}/versions/${target.version}`;
    case 'doc': return `/projects/${target.projectId}/docs/${target.docId}/versions/${target.version}`;
    case 'sketch': return `/map/${target.sketchId}`;
    case 'thought': return `/map/${target.sketchId}#thought-${target.thoughtId}`;
    // A private draft was one of "Your notes"; they are thoughts on My map now (#866), so an old one opens it.
    case 'draft': return '/map';
    case 'person': return `/dm/new?workspace=${encodeURIComponent(target.workspaceId)}&with=${encodeURIComponent(target.userId)}`;
    // Work, decisions and results open in Details on the project's Tasks view (#101, #117).
    default: return `/projects/${target.projectId}/tasks?open=${target.type}:${target.id}`;
  }
}
