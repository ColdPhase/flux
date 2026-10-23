
import type { InspectedComparisonSource } from '@flux/contracts';
import { comparisonSourceHref } from './proposals';
import { RefLink } from '../place/origin';
import { useProjectAiBlocked } from '../ai/workspaceAi';

/** Actual inspected references are separate from the model's selected citations. */
export function ComparisonEvidence({ projectId, sources, unavailable, openResult }: {
  projectId: string; sources: InspectedComparisonSource[] | null; unavailable: number; openResult: (id: string) => void;
}) {
  // F-029 (#614): what a comparison inspected is AI work; it is not shown in a workspace whose AI is off.
  const aiOff = useProjectAiBlocked()(projectId);
  if (aiOff) return null;
  if (sources === null) return <p className="ws-proposal__origin" data-ai-surface="comparison-evidence">The complete checked-source list was not recorded for this earlier suggestion.</p>;
  return <details className="ws-proposal__sources ws-proposal__evidence" data-ai-surface="comparison-evidence">
    <summary>Checked sources <span>{sources.length + unavailable}</span></summary>
    <p className="ws-proposal__origin">These are the sources inspected for this comparison; the cited sources may be a smaller set.</p>
    <ul>{sources.map((source) => {
      const href = comparisonSourceHref(projectId, source);
      const label = source.title || `${source.type.charAt(0).toUpperCase()}${source.type.slice(1)}`;
      return <li key={`${source.type}:${source.id}:${source.version}`}>
        {source.type === 'result'
          ? <button type="button" onClick={() => openResult(source.id)}>{label} <small>· checked version {source.version}</small></button>
          : href ? <RefLink to={href}>{label} <small>· checked version {source.version}</small></RefLink> : null}
        {source.excerpted ? <p className="ws-proposal__origin">Excerpt inspected{source.originalCharacters ? ` · full source ${source.originalCharacters.toLocaleString('en-US')} characters` : ''}.</p> : null}
      </li>;
    })}</ul>
    {unavailable ? <p className="ws-proposal__origin">{unavailable} checked {unavailable === 1 ? 'source is' : 'sources are'} no longer available to you.</p> : null}
    {sources.some((source) => source.type === 'work' || source.type === 'thought')
      ? <p className="ws-proposal__origin">Work and thoughts open their current content; the version shown above is the one checked.</p> : null}
  </details>;
}
