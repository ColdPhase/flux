import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { aiConnectionLabel, type AssistantAnswer, type AssistantProposal, type AssistantRun, type AssistantSourceRef, type ConversationMessage, type WorkItem } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, IconButton } from '../ui';
import { useShellActions } from '../app/shellContext';
import { canRetry, endedText, isWorking, workingText, type AskState } from './format';
import { agentAuthorLabel } from '../docs/format';
import './assistant.css';

// The personal assistant in a project conversation (#57 design, #68 AC-8), in the calm v11
// hierarchy: an answer is an ordinary message whose author is "<Owner>'s assistant", marked as
// an assistant and never as the person; the working line and its Stop are the owner's alone; a
// proposal is the one framed object and only a person with authority sees Accept.

/** The rounded-square ✦ avatar of an assistant: never a person's initials. */
export function AssistantAvatar() {
  return <span className="assistant-avatar" aria-hidden="true"><Icon name="spark" size={15} /></span>;
}

/** "Your assistant ×" above the box, and what will happen: who sees it and who pays, or why not. */
export function AskBar({ id, state, onExit, onAction, error, errorAction = null }: {
  id: string; state: AskState; onExit: () => void; onAction: (action: 'connect' | 'resume' | 'settings') => void; error: string;
  /** A way out of the error the person can take themselves, e.g. a manager granting their assistant access. */
  errorAction?: { label: string; run: () => void } | null;
}) {
  return (
    <div className="ask assistant-ask" id={id}>
      <span className="ask__who"><Icon name="spark" size={13} />Your assistant
        <IconButton icon="x" size={12} label="Stop asking your assistant" className="ask__off" onClick={onExit} />
      </span>
      <span className={`ask__note${state.kind === 'blocked' ? ' assistant-ask__blocked' : ''}`}>{state.note}</span>
      {state.kind === 'blocked' && state.action ? <button type="button" className="ui-link ask__connect" onClick={() => onAction(state.action!)}>{state.actionLabel}</button> : null}
      {error ? <span className="assistant-ask__error" role="alert">{error}{errorAction ? <> <button type="button" className="ui-link ask__connect" onClick={errorAction.run}>{errorAction.label}</button></> : null}</span> : null}
    </div>
  );
}

/** The owner's line where the answer will appear: what the assistant is doing, with Stop. */
export function WorkingLine({ run, onStop, onRetry, onDismiss }: { run: AssistantRun; onStop: () => Promise<void>; onRetry: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setFailed('');
    try { await action(); } catch (error) { setFailed(error instanceof ApiError && error.status === 404 ? 'This run is no longer available.' : 'Couldn’t reach Flux. Try again.'); }
    finally { setBusy(false); }
  };
  const working = isWorking(run);
  const ended = endedText(run);
  return (
    <li className={`assistant-working${working ? ' is-working' : ''}`} aria-live="polite" data-run-status={run.status}>
      <AssistantAvatar />
      <div className="assistant-working__body">
        <p className="assistant-working__text">
          {working ? <span className="assistant-working__pulse" aria-hidden="true" /> : null}
          {working ? workingText(run) : ended}
        </p>
        <p className="assistant-working__who"><Icon name="lock" size={12} />Only you see this · “{run.prompt.length > 90 ? `${run.prompt.slice(0, 90)}…` : run.prompt}”</p>
        {failed ? <p className="assistant-working__error" role="alert">{failed}</p> : null}
      </div>
      <div className="assistant-working__actions">
        {working && !run.stopRequested ? <Button variant="secondary" busy={busy} onClick={() => void act(onStop)}>Stop</Button> : null}
        {!working && canRetry(run) ? <Button variant="quiet" busy={busy} onClick={() => void act(onRetry)}>Retry</Button> : null}
        {!working ? <IconButton icon="x" label="Dismiss" onClick={onDismiss} /> : null}
      </div>
    </li>
  );
}

interface SourceLookups {
  projectId: string;
  messages: ConversationMessage[];
  work: WorkItem[];
  author: (id: string) => string;
}

function SourceLink({ source, index, lookups }: { source: AssistantSourceRef; index: number; lookups: SourceLookups }) {
  const { openDetails } = useShellActions();
  if (source.type === 'message') {
    const message = lookups.messages.find((item) => item.id === source.id);
    const label = message ? `Source ${index}: message #${message.sequence} by ${(message.authorId !== null ? lookups.author(message.authorId) : agentAuthorLabel(message.author))}` : `Source ${index}: a message in this conversation`;
    return <Link className="assistant-cite" to={{ hash: `message-${source.id}` }} aria-label={label} title={label}>{index}</Link>;
  }
  if (source.type === 'work') {
    const item = lookups.work.find((work) => work.id === source.id);
    const label = `Source ${index}: work “${item?.title ?? 'in this project'}”`;
    return <button type="button" className="assistant-cite" aria-label={label} title={label} onClick={() => openDetails({ kind: 'work', id: source.id })}>{index}</button>;
  }
  const label = `Source ${index}: a thought on the project map`;
  return <Link className="assistant-cite" to={`/projects/${lookups.projectId}/map/${source.sketchId}#thought-${source.id}`} aria-label={label} title={label}>{index}</Link>;
}

/** The body with `[n]` citations as links that open exactly the cited object. */
function AnswerBody({ answer, lookups }: { answer: AssistantAnswer; lookups: SourceLookups }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of answer.body.matchAll(/\[(\d{1,3})\]/g)) {
    const index = Number(match[1]);
    const source = answer.sources[index - 1];
    if (!source) continue;
    parts.push(answer.body.slice(last, match.index));
    parts.push(<SourceLink key={`${match.index}-${index}`} source={source} index={index} lookups={lookups} />);
    last = match.index! + match[0].length;
  }
  parts.push(answer.body.slice(last));
  return <p className="assistant-answer__body">{parts}</p>;
}

function sourceSummary(count: number) {
  if (!count) return 'No sources cited';
  return `${count} ${count === 1 ? 'source' : 'sources'} from this project`;
}

export function AnswerItem({ answer, mine, lookups, when, clock, proposal, proposalControls, onRetry, onContinue, onAskAbout }: {
  answer: AssistantAnswer;
  mine: boolean;
  lookups: SourceLookups;
  when: (iso: string) => string;
  clock: (iso: string) => string;
  proposal: AssistantProposal | null;
  proposalControls: ReactNode;
  onRetry: () => Promise<void>;
  onContinue: () => Promise<void>;
  onAskAbout: (() => void) | null;
}) {
  const [busy, setBusy] = useState<'' | 'retry' | 'continue'>('');
  const [failed, setFailed] = useState('');
  const act = async (kind: 'retry' | 'continue', action: () => Promise<void>) => {
    setBusy(kind); setFailed('');
    try { await action(); } catch (error) { setFailed(error instanceof ApiError ? error.message : 'Couldn’t reach Flux. Try again.'); }
    finally { setBusy(''); }
  };
  return (
    <li id={`answer-${answer.runId}`} tabIndex={-1} className="project-convo__message assistant-answer" data-answer-run={answer.runId}>
      <AssistantAvatar />
      <div className="project-convo__message-meta">
        <strong>{answer.assistant.label}</strong>
        <span className="assistant-tag">Assistant</span>
        <span className="assistant-answer__asked">asked by {mine ? 'you' : answer.askedBy.name}</span>
        <time dateTime={answer.committedAt} title={when(answer.committedAt)}>{clock(answer.committedAt)}</time>
      </div>
      <p className="assistant-answer__request">“{answer.request.prompt}”</p>
      <AnswerBody answer={answer} lookups={lookups} />
      {answer.truncated ? <p className="assistant-answer__truncated"><Icon name="alert" size={13} />Stopped at the length limit, so this answer is incomplete.</p> : null}
      {proposal ? proposalControls : null}
      <div className="assistant-answer__foot">
        <span>{sourceSummary(answer.sources.length)} · {aiConnectionLabel(answer.provenance.provider, answer.provenance.model)}</span>
        {mine ? <>
          {answer.truncated ? <Button variant="link" busy={busy === 'continue'} onClick={() => void act('continue', onContinue)}>Continue</Button> : null}
          <Button variant="link" busy={busy === 'retry'} onClick={() => void act('retry', onRetry)}>Retry</Button>
        </> : onAskAbout ? <Button variant="link" onClick={onAskAbout}>Ask my assistant about this</Button> : null}
      </div>
      {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
    </li>
  );
}

/** The one framed object an assistant adds: a result drafted for a person with authority. */
export function ProposalCard({ proposal, workTitle, canDecide, meId, onDecide }: {
  proposal: AssistantProposal;
  workTitle: string | null;
  canDecide: boolean;
  meId: string;
  onDecide: (decision: 'accept' | 'dismiss') => Promise<void>;
}) {
  const { openDetails } = useShellActions();
  const [busy, setBusy] = useState<'' | 'accept' | 'dismiss'>('');
  const [failed, setFailed] = useState('');
  const decide = async (decision: 'accept' | 'dismiss') => {
    setBusy(decision); setFailed('');
    try { await onDecide(decision); }
    catch (error) {
      setFailed(error instanceof ApiError && error.status === 403 ? 'Only someone who can decide this can accept it.'
        : error instanceof ApiError && error.status === 409 ? 'This proposal changed. It has been refreshed.' : 'Couldn’t save. Try again.');
    } finally { setBusy(''); }
  };
  const decidedBy = proposal.decidedBy ? (proposal.decidedBy.id === meId ? 'you' : proposal.decidedBy.name) : '';
  const drafted = proposal.draftedBy.ownerUserId === meId ? 'your assistant' : proposal.draftedBy.label;
  return (
    <section className={`assistant-proposal is-${proposal.status}`} aria-label={`Proposal: ${proposal.change.title}`}>
      <p className="assistant-proposal__label">
        <span className="assistant-proposal__ring" aria-hidden="true" />
        {proposal.status === 'proposed' ? 'Proposal · not saved yet' : proposal.status === 'accepted' ? 'Result recorded' : 'Proposal dismissed'}
      </p>
      <h4 className="assistant-proposal__title">{proposal.change.title}</h4>
      <dl className="assistant-proposal__claims">
        <div><dt>Fact</dt><dd>{proposal.fact}</dd></div>
        <div><dt>Interpretation</dt><dd>{proposal.interpretation}</dd></div>
      </dl>
      {proposal.status === 'proposed' ? <>
        <p className="assistant-proposal__effect">
          Accept records the {proposal.change.finding === 'negative' ? 'negative ' : ''}result{workTitle ? <> and finishes <b>{workTitle}</b></> : null}. Nothing is saved until then.
        </p>
        {canDecide ? <div className="assistant-proposal__actions">
          <Button variant="primary" busy={busy === 'accept'} disabled={!!busy && busy !== 'accept'} onClick={() => void decide('accept')}>Accept</Button>
          <Button variant="quiet" busy={busy === 'dismiss'} disabled={!!busy && busy !== 'dismiss'} onClick={() => void decide('dismiss')}>Dismiss</Button>
        </div> : <p className="assistant-proposal__wait">{proposal.draftedBy.label} drafted this. It waits for someone who can decide it.</p>}
      </> : proposal.status === 'accepted' ? (
        <p className="assistant-proposal__done">
          <Icon name="check" size={13} />Recorded by {decidedBy} · drafted by {drafted}
          {proposal.resultId ? <button type="button" className="ui-link" onClick={() => openDetails({ kind: 'result', id: proposal.resultId! })}>Open result</button> : null}
        </p>
      ) : <p className="assistant-proposal__done">Dismissed by {decidedBy} · nothing was saved</p>}
      {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
    </section>
  );
}
