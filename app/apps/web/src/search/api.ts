import { SEARCH_PATH, searchTargetPath, type SearchResponse } from '@flux/contracts';
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
export const targetHref = searchTargetPath;
