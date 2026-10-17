import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { taskCoordinationPacketPath, type TaskCoordination, type TaskCoordinationRequest, type TaskCoordinationVerdict } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { Button } from '../ui';
import { cancelCoWorkRequest, getTaskCoordination } from './api';
import { KIND_WORDS, splitCards, statusWords, targetWords, verdictWords } from './requestCards';
import { firstName } from './roster';
import './requests.css';

/**
 * A task's request cards in its agents' thread (#400 AC-4, #153): each help, review, fix or hand-off request as one card read
 * from the durable record, in plain words. The thread is their face, never their store. Open requests come first, then the
 * latest closed ones. Everyone who can read the task reads the cards and downloads a request's reference packet; only a
 * project manager or the owner of either agent (the server says: `canCancel`) can cancel an open one. A card never acts for
 * the agents: it claims, answers and acknowledges nothing.
 */

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : dayTime.format(date);
}

function cancelFailure(cause: unknown): string {
  if (cause instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (cause instanceof ApiError) {
    if (cause.code === 'COWORK_VERSION_CONFLICT') return 'This request changed a moment ago. It is shown as it is now; cancel it again if you still want to.';
    if (cause.code === 'COWORK_REQUEST_CLOSED' || cause.code === 'COWORK_REQUEST_EXPIRED') return 'This request was already closed.';
    if (cause.code === 'COWORK_CANCEL_NOT_ALLOWED' || cause.status === 403) return 'Only a project manager or the owner of either agent can cancel a request.';
    if (cause.status === 404) return 'This task is no longer available to you.';
  }
  return 'That didn’t work. Nothing changed; try again.';
}

/** The task's cards, kept current by the project's stream, focus and a slow poll while the tab is visible. */
function useTaskCoordination(workId: string, projectId: string, meId: string) {
  const [data, setData] = useState<TaskCoordination | null>(null);
  const reload = useRef<() => void>(() => { /* set while mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    setData(null);
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getTaskCoordination(workId, current.signal).then((next) => { if (!current.signal.aborted) setData(next); },
        // A failed read keeps what is shown; an unreadable task shows no cards.
        (cause) => { if (!current.signal.aborted && cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) setData(null); });
    };
    reload.current();
    const onFocus = () => reload.current();
    const onVisible = () => { if (document.visibilityState === 'visible') reload.current(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onVisible, 15_000);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval);
      reload.current = () => { /* unmounted */ };
    };
  }, [workId]);
  useStreamEvents(meId, (event) => {
    if (event.objectType === 'project' && event.objectId === projectId) reload.current();
  }, () => reload.current());
  const replace = (card: TaskCoordinationRequest) => setData((current) => current && { ...current, requests: current.requests.map((item) => item.id === card.id ? card : item) });
  return { data, replace, reload: () => reload.current() };
}

function Card({ workId, projectId, card, verdict, onChange, onReload, onOpenMessage }: {
  workId: string; projectId: string; card: TaskCoordinationRequest; verdict: TaskCoordinationVerdict | undefined;
  onChange: (card: TaskCoordinationRequest) => void; onReload: () => void; onOpenMessage: (messageId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const original = card.originalMessage;
  const inThread = original?.space === 'agents' && original.taskId === workId;
  const elsewhere = original && !inThread
    ? original.space === 'agents' ? `/projects/${projectId}/agents?thread=${original.taskId}#message-${original.messageId}`
      : `/projects/${projectId}/conversations/${original.conversationId}#message-${original.messageId}` : null;

  const cancel = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      onChange(await cancelCoWorkRequest(workId, card.id, card.version));
      setConfirming(false);
    } catch (cause) {
      setError(cancelFailure(cause));
      setConfirming(false);
      // A request that moved on is shown as it is now, so the next try names the right version.
      if (cause instanceof ApiError && cause.status === 409) onReload();
    } finally { setBusy(false); }
  };

  return (
    <li className="rcard" data-request-id={card.id} data-status={card.status} data-kind={card.kind}>
      <p className="rcard__head">
        <b className="rcard__kind">{KIND_WORDS[card.kind]}</b>
        <span className="rcard__who">
          <span className="rcard__agent">{card.sender.name}</span><span className="rcard__owner"> for {firstName(card.sender.ownerName)}</span>
          <span aria-hidden="true"> → </span><span className="ui-vh"> to </span>
          <span className="rcard__agent">{card.recipient.name}</span><span className="rcard__owner"> for {firstName(card.recipient.ownerName)}</span>
        </span>
        <time className="rcard__time" dateTime={card.createdAt}>{when(card.createdAt)}</time>
      </p>
      <p className="rcard__target">{targetWords(card)}</p>
      <p className="rcard__state" aria-live="polite">{statusWords(card)}</p>
      {verdict ? <p className="rcard__verdict" data-current={verdict.current ? 'true' : 'false'}>{verdictWords(verdict)}</p> : null}
      <div className="rcard__actions">
        {original ? (inThread
          ? <button type="button" className="ui-link rcard__action" onClick={() => onOpenMessage(original.messageId)}>Open original message</button>
          : <Link className="ui-link rcard__action" to={elsewhere!}>Open original message</Link>) : null}
        <a className="ui-link rcard__action" href={taskCoordinationPacketPath(workId, card.id)} download>Download packet</a>
        {card.canCancel ? (confirming
          ? <span className="rcard__confirm" role="group" aria-label="Cancel this request?">
              <span className="rcard__ask">Cancel this request?</span>
              <Button variant="danger" busy={busy} onClick={() => void cancel()}>Yes, cancel it</Button>
              <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>Keep it</Button>
            </span>
          : <button type="button" className="ui-link rcard__action rcard__cancel" onClick={() => { setError(''); setConfirming(true); }}>Cancel request</button>) : null}
      </div>
      {error ? <p className="rcard__error" role="alert">{error}</p> : null}
    </li>
  );
}

export function RequestCards({ workId, projectId, meId, onOpenMessage }: {
  workId: string; projectId: string; meId: string; onOpenMessage: (messageId: string) => void;
}) {
  const { data, replace, reload } = useTaskCoordination(workId, projectId, meId);
  const [all, setAll] = useState(false);
  useEffect(() => { setAll(false); }, [workId]);
  if (!data || !data.requests.length) return null;
  const { open, closed, earlier } = splitCards(data.requests);
  const visible = new Set([...open, ...closed, ...(all ? earlier : [])].map((card) => card.id));
  const verdicts = new Map(data.verdicts.map((verdict) => [verdict.requestId, verdict]));
  return (
    <section className="rcards" aria-label="Requests between agents">
      <ol className="rcards__list">
        {data.requests.filter((card) => visible.has(card.id)).map((card) => (
          <Card key={card.id} workId={workId} projectId={projectId} card={card} verdict={verdicts.get(card.id)} onChange={replace} onReload={reload} onOpenMessage={onOpenMessage} />
        ))}
      </ol>
      {earlier.length && !all ? <p className="rcards__more"><button type="button" className="ui-link" onClick={() => setAll(true)}>Show {earlier.length} earlier {earlier.length === 1 ? 'request' : 'requests'}</button></p> : null}
    </section>
  );
}
