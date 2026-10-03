import { proactiveComparisonOutcomePath, proactiveComparisonOutcomesPath, proactiveComparisonProposalsPath,
  type InsufficientComparisonOutcome, type Page, type ProactiveComparisonOutcome, type ProactiveComparisonProposal, type WorkItem } from '@flux/contracts';
import { request } from '../api/client.js';

const path = (id: string) => `/api/v1/proactive-comparison-proposals/${id}`;
export function comparisonSourceHref(projectId: string, source: ProactiveComparisonProposal['sources'][number]): string | null {
  if (source.type === 'material') return `/materials/${source.id}/versions/${source.version}`;
  if (source.type === 'message' && source.conversationId)
    return `/projects/${projectId}/conversations/${source.conversationId}#message-${source.id}`;
  if (source.type === 'work') return `/projects/${projectId}/tasks?open=work:${source.id}`;
  if (source.type === 'thought' && source.sketchId) return `/projects/${projectId}/map/${source.sketchId}#thought-${source.id}`;
  return null;
}
export const listComparisonProposals = (projectId: string, signal?: AbortSignal) =>
  request<ProactiveComparisonProposal[]>(proactiveComparisonProposalsPath(projectId), { signal });
/** Load every advertised page instead of silently hiding older quiet outcomes. */
export async function listComparisonOutcomes(projectId: string, signal?: AbortSignal): Promise<ProactiveComparisonOutcome[]> {
  const items: ProactiveComparisonOutcome[] = [];
  for (let offset = 0; ; ) {
    const page = await request<Page<ProactiveComparisonOutcome>>(`${proactiveComparisonOutcomesPath(projectId)}?limit=100&offset=${offset}`, { signal });
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total) return items;
    if (!page.items.length || offset > 10_000) throw new Error('The remaining comparison outcomes could not be loaded.');
  }
}
export const dismissInsufficientComparison = (outcome: InsufficientComparisonOutcome) =>
  request<InsufficientComparisonOutcome>(proactiveComparisonOutcomePath(outcome.id), { method: 'PATCH',
    body: { expectedVersion: outcome.version, status: 'dismissed' } });
export const editComparisonProposal = (proposal: ProactiveComparisonProposal,
  patch: { fact?: string; interpretation?: string; suggestedAction?: string; status?: 'dismissed' }) =>
  request<ProactiveComparisonProposal>(path(proposal.id), { method: 'PATCH',
    body: { expectedVersion: proposal.version, ...patch } });
export const applyComparisonProposal = (proposal: ProactiveComparisonProposal, title: string) =>
  request<{ proposal: ProactiveComparisonProposal; work: WorkItem }>(`${path(proposal.id)}/use`, { method: 'POST',
    body: { expectedVersion: proposal.version, title } });
