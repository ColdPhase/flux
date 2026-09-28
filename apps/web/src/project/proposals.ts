import { proactiveComparisonProposalsPath, type ProactiveComparisonProposal, type WorkItem } from '@flux/contracts';
import { request } from '../api/client.js';

const path = (id: string) => `/api/v1/proactive-comparison-proposals/${id}`;
export function comparisonSourceHref(projectId: string, source: ProactiveComparisonProposal['sources'][number]): string | null {
  if (source.type === 'material') return `/materials/${source.id}/versions/${source.version}`;
  if (source.type === 'message' && source.conversationId)
    return `/projects/${projectId}/conversations/${source.conversationId}#message-${source.id}`;
  return null;
}
export const listComparisonProposals = (projectId: string, signal?: AbortSignal) =>
  request<ProactiveComparisonProposal[]>(proactiveComparisonProposalsPath(projectId), { signal });
export const editComparisonProposal = (proposal: ProactiveComparisonProposal,
  patch: { fact?: string; interpretation?: string; suggestedAction?: string; status?: 'dismissed' }) =>
  request<ProactiveComparisonProposal>(path(proposal.id), { method: 'PATCH',
    body: { expectedVersion: proposal.version, ...patch } });
export const applyComparisonProposal = (proposal: ProactiveComparisonProposal, title: string) =>
  request<{ proposal: ProactiveComparisonProposal; work: WorkItem }>(`${path(proposal.id)}/use`, { method: 'POST',
    body: { expectedVersion: proposal.version, title } });
