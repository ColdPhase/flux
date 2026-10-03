import { useState } from 'react';
import type { InsufficientComparisonOutcome } from '@flux/contracts';
import { Button } from '../ui';
import { ComparisonEvidence } from './ComparisonEvidence';
import { dismissInsufficientComparison } from './proposals';

export function InsufficientComparison({ outcome, ownerName, projectName, writable, refresh, openResult }: {
  outcome: InsufficientComparisonOutcome; ownerName: string; projectName: string; writable: boolean;
  refresh: () => void; openResult: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function dismiss() {
    if (busy) return;
    setBusy(true); setError('');
    try { await dismissInsufficientComparison(outcome); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The outcome could not be dismissed.'); }
    finally { setBusy(false); }
  }
  return <article className="ws-proposal ws-proposal--insufficient" aria-label={`Insufficient evidence for ${projectName}`}>
    <button type="button" className="ws-proposal__toggle" aria-expanded={expanded} aria-controls={`comparison-outcome-${outcome.id}`}
      disabled={busy} onClick={() => setExpanded(!expanded)}>
      <span className="ws-proposal__action">Insufficient evidence</span>
      <span className="ws-proposal__expand">{expanded ? 'Hide details' : 'Inspect'}</span>
      <span className="ws-proposal__source"><span className="ws-proposal__fact">{outcome.reason}</span></span>
    </button>
    <p className="ws-proposal__origin">From {ownerName}’s agent · visible to readers of {projectName}</p>
    {expanded ? <div id={`comparison-outcome-${outcome.id}`} className="ws-proposal__body">
      <p>{outcome.reason}</p>
      <ComparisonEvidence projectId={outcome.projectId} sources={outcome.inspectedSources}
        unavailable={outcome.unavailableSourcesCount} openResult={openResult} />
      {writable ? <div className="ws-proposal__actions"><Button busy={busy} onClick={() => void dismiss()}>Dismiss</Button></div> : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
    </div> : null}
  </article>;
}
