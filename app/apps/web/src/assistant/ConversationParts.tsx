import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { type AssistantAnswer, type AssistantRun, type AssistantSourceRef, type ConversationMessage, type NativeWorkRow } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon, IconButton, Kreska, useLoopPause, type KreskaExpression } from '../ui';
import { useSmallMoments } from '../app/smallMoments';
import { useShellActions } from '../app/shellContext';
import { canRetry, endedText, isWorking, onRuntime, workingText, type AskState } from './format';
import { failure } from './WaitingChanges';
import { useKeepFocus } from './useKeepFocus';
import { agentAuthorLabel } from '../docs/format';
import './assistant.css';
import { RefLink } from '../place/origin';
import { MessageText, type NamedPerson } from '../app/MessageText';
import { useShellData } from '../app/data';
import { plainWords } from '../work/messageWords';
import { shownWords, stepWords, useLiveRun, useReducedMotion } from './liveRun';

// The personal assistant in a project conversation (#57 design, #68 AC-8), in the calm
// hierarchy: its working line and its Stop are the owner's alone, and its answer is the owner's
// alone until Show everyone. What an agent says to the people (a task's discussion) is an ordinary
// message, marked as an agent's.

/** The assistant's face: Kreska, never a person's initials (F-026 P3). Its expression follows the run. */
export function AssistantAvatar({ expression = 'idle' }: { expression?: KreskaExpression }) {
  return <Kreska size={32} expression={expression} className="assistant-avatar" />;
}

/** What the assistant is doing, as Kreska shows it: only real states (#155 AC-3). */
function runExpression(run: AssistantRun): KreskaExpression {
  if (run.stopRequested || run.status === 'stopped') return 'idle';
  switch (run.status) {
    case 'queued': return 'waiting';
    case 'reading': return 'reading';
    case 'paused': case 'revoked': return 'asleep';
    case 'denied': case 'cap_reached': case 'unavailable': case 'input_too_large': case 'provider_failed': return 'worried';
    default: return isWorking(run) ? 'thinking' : 'idle';
  }
}

/** "Your assistant ×" above the box, and what will happen: who sees it and who pays, or why not. */
export function AskBar({ id, state, onExit, onAction, error }: {
  id: string; state: AskState; onExit: () => void; onAction: (action: 'connect' | 'settings' | 'tell' | 'key' | 'join') => void; error: string;
}) {
  return (
    <div className="ask assistant-ask" id={id}>
      <span className="ask__who"><Kreska size={14} />Your assistant
        <IconButton icon="x" size={12} label="Stop asking your assistant" className="ask__off" onClick={onExit} />
      </span>
      <span className={`ask__note${state.kind === 'blocked' ? ' assistant-ask__blocked' : ''}`}>{state.note}</span>
      {state.kind === 'blocked' && state.action ? <button type="button" className="ui-link ask__connect" onClick={() => onAction(state.action!)}>{state.actionLabel}</button> : null}
      {state.kind === 'blocked' && state.also ? <button type="button" className="ui-link ask__connect" onClick={() => onAction(state.also!.action)}>{state.also.label}</button> : null}
      {error ? <span className="assistant-ask__error" role="alert">{error}</span> : null}
    </div>
  );
}

/** "<name> is thinking…" while the run composes (F-026 P5); queued, reading and stopping say what they are; then the step it is on (#1248). */
function WorkingWords({ run }: { run: AssistantRun }) {
  const step = stepWords(useLiveRun(run.status === 'dispatching' && !run.stopRequested ? run.id : null).step);
  if (step) return <>{step}</>;
  if (run.stopRequested || run.status === 'queued' || run.status === 'reading' || onRuntime(run)) return <>{workingText(run)}</>;
  return <><b>Your assistant</b> is thinking…</>;
}

/** The owner's line where the answer will appear: what the assistant is doing, with Stop. */
export function WorkingLine({ run, onStop, onRetry, onDismiss, composerId, changed = 0 }: { run: AssistantRun; onStop: () => Promise<void>; onRetry: () => Promise<void>; onDismiss: () => void;
  /** The box the person writes in: where focus goes when they dismiss the line from the keyboard. */
  composerId?: string;
  /** Changes the run committed before it ended: the line says so instead of "Nothing was posted" and the message below lists them. */
  changed?: number }) {
  const [busy, setBusy] = useState(false);
  // What a failed press said belongs to the run it was pressed for: one line carries a Retry over to its new run.
  const [pressFailed, setFailed] = useState<{ runId: string; text: string } | null>(null);
  const failed = pressFailed?.runId === run.id ? pressFailed.text : '';
  // Stop and Retry go away when pressed; the line keeps the keyboard user's place (AC-8).
  const { ref: home, holds, keep } = useKeepFocus<HTMLLIElement>();
  const act = (action: () => Promise<void>) => keep(async () => {
    const runId = run.id;
    setBusy(true); setFailed(null);
    try { await action(); } catch (error) {
      setFailed({ runId, text: error instanceof NetworkError ? 'Offline' : error instanceof ApiError && error.status === 404 ? 'This run is no longer available.' : 'Couldn’t reach Flux. Try again.' });
    } finally { setBusy(false); }
  });
  const dismiss = () => {
    const inside = holds();
    onDismiss();
    if (inside && composerId) requestAnimationFrame(() => document.getElementById(composerId)?.focus({ preventScroll: true }));
  };
  const working = isWorking(run);
  const ended = endedText(run, changed);
  // Motion follows actual execution only (#155 AC-3): a queued or stopping run is static; its text says why.
  const executing = working && run.status !== 'queued' && !run.stopRequested;
  const loop = useLoopPause<HTMLLIElement>();
  const line = useCallback((node: HTMLLIElement | null) => { home(node); loop(node); }, [home, loop]);
  // Kreska's thinking face is a small moment: with Settings → Appearance off the working line keeps its words and Stop only.
  const moments = useSmallMoments();
  return (
    <li ref={line} tabIndex={-1} className={`assistant-working${executing ? ' is-working' : ''}`} aria-live="polite" data-run-status={run.status}>
      {moments ? <AssistantAvatar expression={runExpression(run)} /> : null}
      <div className="assistant-working__body">
        <p className="assistant-working__text">
          {working ? <WorkingWords run={run} /> : ended}
        </p>
        {/* A run that ended without an answer still says every web address it asked for (#953): nothing else would show them. */}
        {!working && run.webSources ? <p className="assistant-working__sources" data-web-sources>{run.webSources}</p> : null}
        <p className="assistant-working__who"><Icon name="lock" size={12} />Only you see this · “{run.prompt.length > 90 ? `${run.prompt.slice(0, 90)}…` : run.prompt}”</p>
        {failed ? <p className="assistant-working__error" role="alert">{failed}</p> : null}
      </div>
      <div className="assistant-working__actions">
        {working && !run.stopRequested ? <Button variant="secondary" icon="stop" busy={busy} onClick={() => void act(onStop)}>Stop</Button> : null}
        {!working && run.endReason === 'sign_in_again' ? <Link className="ui-btn ui-btn--secondary" to="/settings/agents">Sign in</Link> : null}
        {!working && run.endReason === 'model_unavailable' ? <Link className="ui-btn ui-btn--secondary" to={`/settings/agents/${run.agentId}`}>Choose a model</Link> : null}
        {!working && canRetry(run) ? <Button variant="quiet" busy={busy} onClick={() => void act(onRetry)}>Retry</Button> : null}
        {!working ? <IconButton icon="x" label="Dismiss" onClick={dismiss} /> : null}
      </div>
    </li>
  );
}

/**
 * The answer while it is written (#1248; final design, "An answer appears as it is written"): the card where the answer will be, which only
 * its asker sees, with the words so far and Stop in its own line. A web address in it stays plain words until the answer is done.
 */
export function WritingAnswer({ run, text, onStop, people = null }: { run: AssistantRun; text: string; onStop: () => Promise<void>; people?: readonly NamedPerson[] | null }) {
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === run.agentId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const reduced = useReducedMotion();
  const words = shownWords(text, reduced);
  const stop = async () => {
    setBusy(true); setFailed('');
    try { await onStop(); } catch (error) { setFailed(error instanceof NetworkError ? 'Offline' : 'Couldn’t reach Flux. Try again.'); } finally { setBusy(false); }
  };
  return (
    <li className="assistant-writing" data-writing-run={run.id} data-run-status={run.status} aria-busy="true">
      <div className="assistant-private__who">
        <Kreska size={24} {...(agent ? { hue: agent.colour } : {})} />
        <strong>{agent?.name ?? 'Assistant'}</strong>
        <span className="assistant-writing__state">· {run.stopRequested ? 'stopping…' : 'writing…'}</span>
        <span className="assistant-private__lock"><Icon name="lock" size={13} />Only you can see this</span>
      </div>
      <p className="assistant-private__asked">You asked: <code>/ai</code> {run.prompt}</p>
      <WritingWords words={words} reduced={reduced} people={people} />
      {run.stopRequested ? null : <div className="assistant-writing__foot"><Button variant="outline" icon="stop" busy={busy} onClick={() => void stop()}>Stop</Button></div>}
      {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
    </li>
  );
}

/** The words so far, formatted, with the caret at their end (none with reduced motion). Read out once done, not word by word. */
export function WritingWords({ words, reduced, people = null }: { words: string; reduced: boolean; people?: readonly NamedPerson[] | null }) {
  return (
    <div className="assistant-answer__body assistant-writing__words" aria-live="off" data-writing-words="">
      <MessageText body={words} linked={false} people={people} />
      {reduced ? null : <span className="assistant-writing__caret" aria-hidden="true" />}
    </div>
  );
}

/** The answer's words for the clipboard: plain, without the marks (Copy text, #1247), and without its `[n]` source marks. */
export function answerWords(answer: Pick<AssistantAnswer, 'body' | 'sources'>): string {
  return plainWords(answer.body).replace(/[ \t]?\[(\d{1,3})\]/g, (mark, number: string) => (Number(number) >= 1 && Number(number) <= answer.sources.length ? '' : mark));
}

/** Copy and Try again under a finished answer (#1248), quiet and in the answer's own line. */
export function AnswerTools({ answer, onRetry }: { answer: Pick<AssistantAnswer, 'body' | 'sources'>; onRetry: () => Promise<void> }) {
  const [copied, setCopied] = useState<'' | 'copied' | 'failed'>('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let next: 'copied' | 'failed' = 'copied';
    try { await navigator.clipboard.writeText(answerWords(answer)); } catch { next = 'failed'; }
    setCopied(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(''), 2000);
  };
  const retry = async () => {
    setBusy(true); setFailed('');
    try { await onRetry(); } catch (error) { setFailed(error instanceof NetworkError ? 'Offline' : error instanceof ApiError && error.message ? error.message : 'Couldn’t reach Flux. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="assistant-answer__tools" data-answer-tools="">
      <Button variant="quiet" size="sm" icon={copied === 'copied' ? 'check' : 'copy'} onClick={() => void copy()}>{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy'}</Button>
      <Button variant="quiet" size="sm" busy={busy} onClick={() => void retry()}>Try again</Button>
      <span className="ui-vh" role="status">{copied === 'copied' ? 'Answer copied' : ''}</span>
      {failed ? <span className="assistant-answer__error" role="alert">{failed}</span> : null}
    </div>
  );
}

/** "Finishing your daily check first. Yours starts next. · Stop the daily check": the request waits behind a background run of the owner. */
export function BehindLine({ label, onStop }: { label: string | null; onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const name = label ?? 'background work';
  const stop = async () => {
    setBusy(true); setFailed('');
    try { await onStop(); } catch (error) { setFailed(failure(error)); } finally { setBusy(false); }
  };
  return (
    <li className="assistant-queued" aria-live="polite">
      <span>Finishing your <b>{name}</b> first. Yours starts next.</span>
      <Button variant="link" busy={busy} onClick={() => void stop()}>Stop the {name.charAt(0).toLowerCase() + name.slice(1)}</Button>
      {failed ? <span className="assistant-working__error" role="alert">{failed}</span> : null}
    </li>
  );
}

export interface SourceLookups {
  projectId: string;
  messages: ConversationMessage[];
  work: ReadonlyMap<string, NativeWorkRow>;
  author: (id: string) => string;
  /** The names a `@Name Surname` in the answer may stand for, so a name with a space is one chip. */
  people?: readonly NamedPerson[] | null;
}

function SourceLink({ source, index, lookups }: { source: AssistantSourceRef; index: number; lookups: SourceLookups }) {
  const { openDetails } = useShellActions();
  if (source.type === 'message') {
    const message = lookups.messages.find((item) => item.id === source.id);
    const label = message ? `Source ${index}: message #${message.sequence} by ${(message.authorId !== null ? lookups.author(message.authorId) : agentAuthorLabel(message.author))}` : `Source ${index}: a message in this conversation`;
    return <Link className="assistant-cite" to={{ hash: `message-${source.id}` }} aria-label={label} title={label}>{index}</Link>;
  }
  if (source.type === 'work') {
    const item = lookups.work.get(`work:${source.id}`);
    const label = `Source ${index}: work “${item?.title ?? 'in this project'}”`;
    return <button type="button" className="assistant-cite" data-native-ref={`work:${source.id}`} aria-label={label} title={label} onClick={() => openDetails({ kind: 'work', id: source.id })}>{index}</button>;
  }
  const label = `Source ${index}: a thought on the project map`;
  return <RefLink className="assistant-cite" to={`/projects/${lookups.projectId}/map/${source.sketchId}#thought-${source.id}`} aria-label={label} title={label}>{index}</RefLink>;
}

/** The body as formatted text (the one message renderer, #1247) with `[n]` citations as links that open exactly the cited object. */
export function AnswerBody({ answer, lookups }: { answer: Pick<AssistantAnswer, 'body' | 'sources'>; lookups: SourceLookups }) {
  const cite = (index: number) => {
    const source = answer.sources[index - 1];
    return source ? <SourceLink source={source} index={index} lookups={lookups} /> : null;
  };
  return <div className="assistant-answer__body"><MessageText body={answer.body} cite={cite} people={lookups.people ?? null} /></div>;
}

export function sourceSummary(count: number, from = 'this project') {
  if (!count) return 'No sources cited';
  return `${count} ${count === 1 ? 'source' : 'sources'} from ${from}`;
}
