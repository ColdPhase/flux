import { useState } from 'react';
import { Link } from 'react-router';
import { WORK_LIMITS, type InsufficientComparisonOutcome, type ProactiveComparisonOutcome, type ProactiveComparisonProposal, type ProjectPerson, type WorkItem } from '@flux/contracts';
import { Button } from '../ui';
import { applyComparisonProposal, comparisonSourceHref, editComparisonProposal } from './proposals';
import { ComparisonEvidence } from './ComparisonEvidence';
import { InsufficientComparison } from './InsufficientComparison';

export function ProjectProposals({ outcomes, people, projectName, resultTitles, workJumpId, workCount, resultCount, jumpToSection, writable, refresh, openResult, openWork }: {
  outcomes: ProactiveComparisonOutcome[]; people: ProjectPerson[] | null; projectName: string; writable: boolean;
  resultTitles: Map<string, string>;
  workJumpId: string; workCount: number; resultCount: number;
  jumpToSection: (id: string) => void;
  refresh: () => void; openResult: (id: string) => void; openWork: (item: WorkItem) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [fact, setFact] = useState('');
  const [interpretation, setInterpretation] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = outcomes.flatMap((outcome) => outcome.kind === 'comparison' && outcome.proposal.status === 'proposed' ? [outcome] : []);
  const insufficient = outcomes.filter((outcome): outcome is InsufficientComparisonOutcome => outcome.kind === 'insufficient_evidence' && outcome.status === 'open');
  if (!open.length && !insufficient.length) return null;
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
      <h2 className="ws-group__h" id="g-comparison-proposals">Suggestions and checks <span>{open.length + insufficient.length}</span></h2>
      <nav className="ws-proposals__jumps" aria-label="Project work sections">
        {workCount ? <button type="button" onClick={() => jumpToSection(workJumpId)}>Work {workCount}</button> : null}
        {resultCount ? <button type="button" onClick={() => jumpToSection('g-results')}>Results {resultCount}</button> : null}
      </nav>
      <p className="ws-proposals__intro">Quiet project suggestions. The agent has not changed any work or decision.</p>
      {open.map(({ proposal, inspectedSources, unavailableSourcesCount }) => {
        const isEditing = editing === proposal.id;
        const isExpanded = expanded === proposal.id;
        return <article className="ws-proposal" key={proposal.id} aria-label={`Comparison suggestion for ${projectName}`}>
          <button type="button" className="ws-proposal__toggle" aria-expanded={isExpanded}
            aria-controls={`comparison-proposal-${proposal.id}`} disabled={busy}
            onClick={() => { setExpanded(isExpanded ? null : proposal.id); setEditing(null); setError(''); }}>
            <span className="ws-proposal__action">{proposal.suggestedAction}</span>
            <span className="ws-proposal__expand">{isExpanded ? 'Hide details' : 'Review'}</span>
            <span className="ws-proposal__source"><span className="ws-proposal__trigger">After: {resultTitles.get(proposal.resultId) ?? 'Project result'}</span><span className="ws-proposal__separator"> · </span><span className="ws-proposal__fact">{proposal.fact}</span></span>
          </button>
          <p className="ws-proposal__origin">From {name(proposal.ownerUserId)}’s agent · visible to readers of {projectName}</p>
          {isExpanded ? <div id={`comparison-proposal-${proposal.id}`} className="ws-proposal__body">
          {isEditing ? <>
            <label>Observed fact<textarea value={fact} maxLength={10000} onChange={(event) => setFact(event.target.value)} /></label>
            <label>Interpretation<textarea value={interpretation} maxLength={10000} onChange={(event) => setInterpretation(event.target.value)} /></label>
            <label>Suggested next step<textarea value={action} maxLength={WORK_LIMITS.outcome} onChange={(event) => setAction(event.target.value)} /></label>
          </> : <>
            <p className="ws-proposal__detail"><strong>Observed fact</strong> <span>{proposal.fact}</span></p>
            <p className="ws-proposal__detail"><strong>Interpretation</strong> <span>{proposal.interpretation}</span></p>
            <p className="ws-proposal__detail"><strong>Suggested next step</strong> <span>{proposal.suggestedAction}</span></p>
          </>}
          <div className="ws-proposal__sources"><strong>Sources cited</strong>
            <ul>{proposal.sources.map((source) => <li key={`${source.type}:${source.id}:${source.version}`}>
              {source.type === 'material'
                ? <Link title={`Material ${source.id}, version ${source.version}`} to={comparisonSourceHref(proposal.projectId, source)!}>{source.title ?? `Material ${source.id.slice(0, 8)}`} <small>· version {source.version}</small></Link>
                : source.type === 'result'
                  ? <button type="button" title={`Result ${source.id}, version ${source.version}`} onClick={() => openResult(source.id)}>{source.title ?? resultTitles.get(source.id) ?? `Result ${source.id.slice(0, 8)}`} <small>· cited version {source.version}</small></button>
                  : source.type === 'work'
                    ? <Link title={`Cited work version ${source.version}; opens current work`} to={comparisonSourceHref(proposal.projectId, source)!}>{source.title ?? `Work ${source.id.slice(0, 8)}`} <small>· cited version {source.version}</small></Link>
                  : source.type === 'thought'
                    ? comparisonSourceHref(proposal.projectId, source)
                      ? <Link title={`Cited thought version ${source.version}; opens current thought`} to={comparisonSourceHref(proposal.projectId, source)!}>{source.title ?? `Thought ${source.id.slice(0, 8)}`} <small>· cited version {source.version}</small></Link>
                      : <span>Thought · cited version {source.version} (source unavailable)</span>
                  : source.conversationId
                    ? <Link title={`Message ${source.id}, version ${source.version}`} to={comparisonSourceHref(proposal.projectId, source)!}>{source.title ?? `Project message ${source.id.slice(0, 8)}`}</Link>
                    : <span title={`Message ${source.id}, version ${source.version}`}>Project message · {source.id.slice(0, 8)} (source unavailable)</span>}
            </li>)}</ul>
          </div>
          <ComparisonEvidence projectId={proposal.projectId} sources={inspectedSources}
            unavailable={unavailableSourcesCount} openResult={openResult} />
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
      {insufficient.map((outcome) => <InsufficientComparison key={outcome.id} outcome={outcome}
        ownerName={name(outcome.ownerUserId)} projectName={projectName} writable={writable}
        refresh={refresh} openResult={openResult} />)}
    </section>
  );
}
