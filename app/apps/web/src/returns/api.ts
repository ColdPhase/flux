import { RETURN_POINTS_PATH, RETURN_SUMMARY_PATH, type ReturnPlace, type ReturnPoint, type ReturnSource, type ReturnSummary } from '@flux/contracts';
import { request } from '../api/client';
import { noteLockedWorkspaces } from '../encryption/api';

/** The summary of a place since its server-side return point (#106): what Home continues from and what is new in a space. */
export function getReturnSummary(place: ReturnPlace, signal?: AbortSignal) {
  const query = place.type === 'home' ? 'place=home' : `place=${place.type}&id=${encodeURIComponent(place.id)}`;
  return request<ReturnSummary>(`${RETURN_SUMMARY_PATH}?${query}`, { signal }).then(noteLockedWorkspaces);
}
export const saveReturnPoint = (place: ReturnPlace, mark: string | null) =>
  request<ReturnPoint>(RETURN_POINTS_PATH, { method: 'PUT', body: { place, mark }, leavesReads: true });

/** Where an item's source opens. Work and decisions open in Details on their project. */
export function sourceHref(source: ReturnSource) {
  switch (source.type) {
    case 'message': return `/projects/${source.projectId}/conversations/${source.conversationId}#message-${source.messageId}`;
    case 'material': return `/materials/${source.materialId}/versions/${source.version}`;
    case 'sketch': return source.projectId ? `/projects/${source.projectId}/map/${source.sketchId}` : `/map/${source.sketchId}`;
    case 'doc': return source.since ? `/projects/${source.projectId}/docs/${source.docId}/history?from=${source.since}&to=${source.version}` : `/projects/${source.projectId}/docs/${source.docId}`;
    default: return `/projects/${source.projectId}`;
  }
}
