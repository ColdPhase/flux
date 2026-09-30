import {
  RETURN_POINTS_PATH, RETURN_POINTS_RESTORE_PATH, RETURN_SUMMARY_PATH,
  type ReturnPeriod, type ReturnPlace, type ReturnPoint, type ReturnScope, type ReturnSource, type ReturnSummary,
} from '@flux/contracts';
import { request } from '../api/client';

/** "Since you left" (#106): the summary of a place and its server-side return point. */
export function getReturnSummary(place: ReturnPlace, signal?: AbortSignal) {
  const query = place.type === 'home' ? 'place=home' : `place=${place.type}&id=${encodeURIComponent(place.id)}`;
  return request<ReturnSummary>(`${RETURN_SUMMARY_PATH}?${query}`, { signal });
}
/** "What matters" (#133): a project's private recap in a scope and period, at a snapshot `until` when given. */
export function getRecap({ projectId, scope, period, until, digest }: { projectId: string; scope: ReturnScope; period: ReturnPeriod; until: string | null; digest: boolean }, signal?: AbortSignal) {
  const query = new URLSearchParams({ place: 'project', id: projectId, scope, from: period });
  if (until) query.set('until', until);
  if (digest) query.set('digest', '1');
  return request<ReturnSummary>(`${RETURN_SUMMARY_PATH}?${query}`, { signal });
}
export const saveReturnPoint = (place: ReturnPlace, mark: string | null) =>
  request<ReturnPoint>(RETURN_POINTS_PATH, { method: 'PUT', body: { place, mark } });
export const restoreReturnPoint = (place: ReturnPlace) =>
  request<ReturnPoint>(RETURN_POINTS_RESTORE_PATH, { method: 'POST', body: { place } });

/** Where an item's source opens. Work, decisions and results open in Details on their project. */
export function sourceHref(source: ReturnSource) {
  switch (source.type) {
    case 'message': return `/projects/${source.projectId}/conversations/${source.conversationId}#message-${source.messageId}`;
    case 'material': return `/materials/${source.materialId}/versions/${source.version}`;
    case 'sketch': return `/map/${source.sketchId}`;
    case 'doc': return source.since ? `/projects/${source.projectId}/docs/${source.docId}/history?from=${source.since}&to=${source.version}` : `/projects/${source.projectId}/docs/${source.docId}`;
    default: return `/projects/${source.projectId}`;
  }
}
