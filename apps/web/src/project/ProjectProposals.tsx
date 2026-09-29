import { useState } from 'react';
import { Link } from 'react-router';
import type { ProactiveComparisonProposal, ProjectPerson, WorkItem } from '@flux/contracts';
import { Button } from '../ui';
import { applyComparisonProposal, comparisonSourceHref, editComparisonProposal } from './proposals';

export function ProjectProposals({ proposals, people, projectName, resultTitles, writable, refresh, openResult, openWork }: {
  proposals: ProactiveComparisonProposal[]; people: ProjectPerson[] | null; projectName: string; writable: boolean;
  resultTitles: Map<string, string>;
  refresh: () => void; openResult: (id: string) => void; openWork: (item: WorkItem) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [fact, setFact] = useState('');
  const [interpretation, setInterpretation] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = proposals.filter((proposal) => proposal.status === 'proposed');
  if (!open.length) return null;
  const name = (id: string) => people?.find((person) => person.id === id)?.name ?? 'a project member';
  const beginEdit = (proposal: ProactiveComparisonProposal) => {
    setEditing(proposal.id); setFact(proposal.fact); setInterpretation(proposal.interpretation);
    setAction(proposal.suggestedAction); setError('');
  };
  const change = async (proposal: ProactiveComparisonProposal, kind: 'edit' | 'dismiss' | 'use') => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (kind === 'edit') {
        await editComparisonProposal(proposal, { fact, interpretation, suggestedAction: action });
      } else if (kind === 'dismiss') {
        await editComparisonProposal(proposal, { status: 'dismissed' });
      } else {
        const outcome = await applyComparisonProposal(proposal, proposal.suggestedAction.slice(0, 200));
        openWork(outcome.work);
      }
      setEditing(null);
      if (kind !== 'edit') setExpanded(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The proposal could not be changed.');
    } finally { setBusy(false); }
  };
  return (
    <section className="ws-group ws-proposals" aria-labelledby="g-comparison-proposals">
      <h2 className="ws-group__h" id="g-comparison-proposals">Suggestions to review <span>{open.length}</span></h2>
      <p className="ws-proposals__intro">Quiet project suggestions. The agent has not changed any work or decision.</p>
      {open.map((proposal) => {
        const isEditing = editing === proposal.id;
        const isExpanded = expanded === proposal.id;
        return <article className="ws-proposal" key={proposal.id} aria-label={`Comparison suggestion for ${projectName}`}>
          <button type="button" className="ws-proposal__toggle" aria-expanded={isExpanded}
            aria-controls={`comparison-proposal-${proposal.id}`} disabled={busy}
            onClick={() => { setExpanded(isExpanded ? null : proposal.id); setEditing(null); setError(''); }}>
            <span className="ws-proposal__action">{proposal.suggestedAction}</span>
            <span className="ws-proposal__expand">{isExpanded ? 'Hide details' : 'Review'}</span>
            <span className="ws-proposal__source">After: {resultTitles.get(proposal.resultId) ?? 'Project result'} · {proposal.fact}</span>
          </button>
          <p className="ws-proposal__origin">From {name(proposal.ownerUserId)}’s agent · visible to readers of {projectName}</p>
          {isExpanded ? <div id={`comparison-proposal-${proposal.id}`} className="ws-proposal__body">
          {isEditing ? <>
            <label>Observed fact<textarea value={fact} maxLength={10000} onChange={(event) => setFact(event.target.value)} /></label>
            <label>Interpretation<textarea value={interpretation} maxLength={10000} onChange={(event) => setInterpretation(event.target.value)} /></label>
            <label>Suggested next step<textarea value={action} maxLength={10000} onChange={(event) => setAction(event.target.value)} /></label>
          </> : <>
            <p className="ws-proposal__detail"><strong>Observed fact</strong> <span>{proposal.fact}</span></p>
            <p className="ws-proposal__detail"><strong>Interpretation</strong> <span>{proposal.interpretation}</span></p>
            <p className="ws-proposal__detail"><strong>Suggested next step</strong> <span>{proposal.suggestedAction}</span></p>
          </>}
          <div className="ws-proposal__sources"><strong>Sources</strong>
            <ul>{proposal.sources.map((source) => <li key={`${source.type}:${source.id}:${source.version}`}>
              {source.type === 'material'
                ? <Link title={`Material ${source.id}, version ${source.version}`} to={comparisonSourceHref(proposal.projectId, source)!}>Material · version {source.version}</Link>
                : source.type === 'result'
                  ? <button type="button" title={`Result ${source.id}, version ${source.version}`} onClick={() => openResult(source.id)}>Result · {resultTitles.get(source.id) ?? source.id.slice(0, 8)}</button>
                  : source.conversationId
                    ? <Link title={`Message ${source.id}, version ${source.version}`} to={comparisonSourceHref(proposal.projectId, source)!}>Project message · {source.id.slice(0, 8)}</Link>
                    : <span title={`Message ${source.id}, version ${source.version}`}>Project message · {source.id.slice(0, 8)} (source unavailable)</span>}
            </li>)}</ul>
          </div>
          {writable ? <div className="ws-proposal__actions">
            {isEditing ? <>
              <Button variant="primary" busy={busy} disabled={!fact.trim() || !interpretation.trim() || !action.trim()}
                onClick={() => void change(proposal, 'edit')}>Save edits</Button>
              <Button disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Cancel</Button>
            </> : <>
              <Button disabled={busy} onClick={() => beginEdit(proposal)}>Edit</Button>
              <Button disabled={busy} onClick={() => void change(proposal, 'use')}>Use as work</Button>
            </>}
            <Button disabled={busy} onClick={() => void change(proposal, 'dismiss')}>Dismiss</Button>
          </div> : null}
          {error ? <p className="wd-error" role="alert">{error}</p> : null}
          </div> : null}
        </article>;
      })}
    </section>
  );
}
