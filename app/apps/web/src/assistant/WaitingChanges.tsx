import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assistantBatchVerb, assistantChangeSummary, assistantMessageHeader, type AssistantChange } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button } from '../ui';
import { applyChange, applyRunChanges, listConversationChanges, moveRunChangesToInbox, notNowRunChanges, sendChange, undoChange, undoRunChanges } from './api';

// What the owner's assistant prepared in this conversation and waits for them on (F-027 AST-5, A3). Only the
// owner's own changes ever reach this view: the server answers everyone else with nothing.

const pending = (change: AssistantChange) => change.state === 'waiting' && change.waitReason !== 'live_wiki' && change.waitReason !== 'outside_rights';
const deferred = (change: AssistantChange) => change.state === 'waiting' && change.waitReason === 'live_wiki';
const suggestion = (change: AssistantChange) => change.state === 'waiting' && change.waitReason === 'outside_rights';
/** Lines worth keeping after a decision: applied after the wait, changed since, expired. */
const settled = (change: AssistantChange) => change.state === 'applied_after_wait' || change.state === 'refused' && change.waitReason === null && change.line !== null
  && !change.line.startsWith('Skipped') || change.state === 'expired';

/** Made by the run and still on the record: applied (possibly after a wait), or undone by the owner. */
const made = (change: AssistantChange) => change.state === 'applied' || change.state === 'applied_after_wait' || change.state === 'undone';
const skipped = (change: AssistantChange) => change.state === 'refused' && !!change.line?.startsWith('Skipped');

/** The owner's changes of this conversation, by run; undecided ones move to Inbox when the owner leaves (P2-4). */
export function useAssistantChanges(conversationId: string | null, refreshKey: unknown) {
  const [changes, setChanges] = useState<AssistantChange[]>([]);
  const refresh = useCallback(async () => {
    if (!conversationId) { setChanges([]); return; }
    try { setChanges((await listConversationChanges(conversationId)).items); } catch { /* the conversation reports lost access itself */ }
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    listConversationChanges(conversationId).then((page) => { if (live) setChanges(page.items); }).catch(() => undefined);
    return () => { live = false; };
  }, [conversationId, refreshKey]);
  const waitingRuns = useRef<string[]>([]);
  useEffect(() => { waitingRuns.current = [...new Set(changes.filter(pending).map((change) => change.runId))]; }, [changes]);
  useEffect(() => () => { for (const runId of waitingRuns.current) void moveRunChangesToInbox(runId).catch(() => undefined); }, [conversationId]);
  const byRun = useMemo(() => {
    const runs = new Map<string, AssistantChange[]>();
    for (const change of changes) if (pending(change) || deferred(change) || suggestion(change) || settled(change) || made(change) || skipped(change)) runs.set(change.runId, [...(runs.get(change.runId) ?? []), change]);
    return runs;
  }, [changes]);
  return { byRun, refresh };
}

const failure = (error: unknown) => error instanceof ApiError && error.message ? error.message : 'Couldn’t reach Flux. Try again.';

const OBJECT_WORD: Record<string, string> = { work: 'Task', doc: 'Page', map: 'Map', thought: 'Thought', link: 'Link', message: 'Message', result: 'Result', decision: 'Decision' };

/**
 * The run's one message (F-027 AST-10.13): a header naming what changed with Undo for all of it, at most three object
 * rows and "+N more", before and after and a per-item Undo when expanded. Shown once the run is no longer working.
 */
function RunMessage({ changes, onChanged }: { changes: AssistantChange[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const done = changes.filter(made);
  const skips = changes.filter(skipped);
  if (!done.length && !skips.length || changes[0]!.runState === 'working') return null;
  const live = done.filter((change) => change.state !== 'undone');
  const allUndone = done.length > 0 && !live.length;
  const undoable = live.some((change) => change.undoable);
  const runId = changes[0]!.runId;
  const header = allUndone ? `Undone by ${done.find((change) => change.decidedBy)?.decidedBy?.name ?? 'you'}` : live.length && live.length < done.length ? `Undid ${done.length - live.length} of ${done.length} changes` : live.length ? assistantMessageHeader(live) : 'Nothing was changed';
  const shown = open ? done : done.slice(0, 3);
  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch (error) { setNote(failure(error)); }
    finally { setBusy(''); await onChanged(); }
  };
  const undoAll = () => act('all', async () => { const result = await undoRunChanges(runId); setNote(result.changedSince.length || result.message !== `Undid ${result.undone} change${result.undone === 1 ? '' : 's'}` ? result.message : ''); });
  const undoOne = (change: AssistantChange) => act(change.id, async () => {
    const result = await undoChange(change);
    setItemNotes((current) => ({ ...current, [change.id]: result.message ?? '' }));
  });
  return (
    <section className="assistant-message" aria-label="What your assistant changed" data-run={runId}>
      <p className="assistant-message__head" role="status" aria-live="polite"><span>{header}</span>
        {undoable ? <Button variant="link" busy={busy === 'all'} disabled={!!busy && busy !== 'all'} onClick={() => void undoAll()}>Undo</Button> : null}</p>
      {note ? <p className="assistant-message__note" role="status">{note}</p> : null}
      {shown.length ? <ul className="assistant-message__rows">
        {shown.map((change) => (
          <li key={change.id} data-state={change.state}>
            <span className="assistant-message__kind">{OBJECT_WORD[change.objectType] ?? 'Item'}</span>
            <span className="assistant-message__title">{change.objectTitle || change.phrase}</span>
            {open && change.state !== 'undone' && change.before !== null ? <span className="assistant-message__diff"><s>{change.before}</s> → {change.after}</span>
              : open && change.state !== 'undone' && change.after && change.after !== change.objectTitle ? <span className="assistant-message__diff">{change.after}</span> : null}
            {change.state === 'undone' || change.state === 'applied_after_wait' ? <span className="assistant-message__diff">{change.line}</span> : null}
            {open && change.undoable ? <span className="assistant-message__item">
              {itemNotes[change.id] ? <span>{itemNotes[change.id]}</span> : null}
              <Button variant="link" busy={busy === change.id} disabled={!!busy && busy !== change.id} onClick={() => void undoOne(change)}>Undo</Button></span> : null}
          </li>
        ))}
      </ul> : null}
      {done.length > 3 || done.some((change) => change.before !== null || change.after !== null || change.undoable) ? (
        <Button variant="quiet" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide details' : done.length > 3 ? `+${done.length - 3} more` : 'Show details'}</Button>) : null}
      {skips.map((change) => <p key={change.id} className="assistant-message__skipped">{change.line}</p>)}
    </section>
  );
}

/** One run's "Waiting for you: add 2 tasks, edit 1 page" with the object's own verb, Review and Not now. */
export function WaitingChanges({ changes, onChanged }: { changes: AssistantChange[]; onChanged: () => Promise<void> }) {
  const waiting = changes.filter(pending);
  const [reviewing, setReviewing] = useState(false);
  // Review starts with every change ticked; the owner unticks what they do not want.
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const runId = changes[0]!.runId;
  const act = async (key: string, action: () => Promise<{ changes?: { message: string | null }[]; message?: string | null } | unknown>) => {
    setBusy(key); setMessages([]);
    try {
      const result = await action() as { changes?: { message: string | null }[]; message?: string | null };
      setMessages([...(result.changes ?? []).map((entry) => entry.message), result.message ?? null].filter((message): message is string => !!message));
    } catch (error) { setMessages([failure(error)]); }
    finally { setBusy(''); await onChanged(); }
  };
  const selected = waiting.filter((change) => !unticked.has(change.id));
  const applySelected = () => act('apply', async () => {
    const results: { message: string | null }[] = [];
    for (const change of selected) {
      try { results.push(await applyChange(change)); } catch (error) { results.push({ message: failure(error) }); }
    }
    return { changes: results };
  });
  const verb = assistantBatchVerb(reviewing ? selected : waiting);
  const hasWaitingParts = waiting.length > 0 || changes.some((change) => deferred(change) || suggestion(change) || settled(change) && !made(change));
  return (<>
    <RunMessage changes={changes} onChanged={onChanged} />
    {hasWaitingParts || messages.length ? <section className="assistant-waiting" aria-label="Your assistant's changes" data-run={runId}>
      {waiting.length ? <>
        <p className="assistant-waiting__head"><span className="assistant-proposal__ring" aria-hidden="true" />Waiting for you: {assistantChangeSummary(waiting)}</p>
        {reviewing ? <ul className="assistant-waiting__list">
          {waiting.map((change) => (
            <li key={change.id}>
              <label>
                <input type="checkbox" checked={!unticked.has(change.id)} onChange={(event) => setUnticked((current) => {
                  const next = new Set(current); if (event.target.checked) next.delete(change.id); else next.add(change.id); return next;
                })} />
                <span><b>{change.phrase}</b>{change.objectTitle ? ` ${change.objectTitle}` : ''}{change.line ? <small>{change.line}</small> : null}</span>
              </label>
            </li>
          ))}
        </ul> : <p className="assistant-waiting__why">{[...new Set(waiting.map((change) => change.line).filter(Boolean))].join(' · ')}</p>}
        <div className="assistant-proposal__actions">
          <Button variant="primary" busy={busy === 'apply'} disabled={!!busy && busy !== 'apply' || reviewing && !selected.length}
            onClick={() => void (reviewing ? applySelected() : act('apply', () => applyRunChanges(runId)))}>{verb}</Button>
          <Button variant="secondary" aria-expanded={reviewing} disabled={!!busy} onClick={() => setReviewing((open) => !open)}>Review</Button>
          <Button variant="quiet" busy={busy === 'not-now'} disabled={!!busy && busy !== 'not-now'}
            onClick={() => void act('not-now', () => notNowRunChanges(runId))}>Not now</Button>
        </div>
      </> : null}
      {changes.filter(deferred).map((change) => <p key={change.id} className="assistant-waiting__line">{change.line}</p>)}
      {changes.filter(suggestion).map((change) => (
        <p key={change.id} className="assistant-waiting__line">
          {change.sent ? change.line : <>{change.line?.replace(/ · Send to .*$/, '')}
            {change.suggestTo ? <Button variant="link" busy={busy === change.id} disabled={!!busy && busy !== change.id}
              onClick={() => void act(change.id, () => sendChange(change))}>Send to {change.suggestTo.name}</Button> : null}</>}
        </p>
      ))}
      {changes.filter((change) => settled(change) && !made(change)).map((change) => <p key={change.id} className="assistant-waiting__done">
        {change.state === 'applied_after_wait' ? `${change.verb === 'Apply' ? 'Applied' : 'Done'}: ${change.phrase}${change.objectTitle ? ` ${change.objectTitle}` : ''} · ${change.line}` : change.line}
      </p>)}
      {messages.length ? <p className="assistant-answer__error" role="alert">{[...new Set(messages)].join(' · ')}</p> : null}
    </section> : null}
  </>);
}
