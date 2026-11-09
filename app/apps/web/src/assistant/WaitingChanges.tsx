import { useCallback, useEffect, useMemo, useState } from 'react';
import { assistantChangeLine, WORK_LIMITS, type AssistantChange } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';

import { Button } from '../ui';
import { useShellActions } from '../app/shellContext';
import { applyChange, editChange, listConversationChanges, listRunChanges, skipChange, undoRunChanges } from './api';
import { RefLink } from '../place/origin';
import { useKeepFocus } from './useKeepFocus';
import { ClampedWords } from './ClampedWords';
import { peopleNamed } from './peopleNamed';

// An agent's message about what it changed, and what waits for its owner (F-036 AG-3, #855; mockup UndoApproval).
// Everyone who can read the conversation sees the change line with Undo; only the owner sees what waits, and only the
// owner, in their own session, decides it: Approve, Edit or Skip, Delete or Keep.

const waiting = (change: AssistantChange) => change.state === 'waiting';
/** Made by the run and still on the record: applied (possibly after a wait), or undone. */
const made = (change: AssistantChange) => change.state === 'applied' || change.state === 'applied_after_wait' || change.state === 'undone';
/** A change a person made meanwhile kept from being made: "Skipped #4: Jonas changed it while I worked". */
const skipped = (change: AssistantChange) => change.state === 'refused' && !!change.line?.startsWith('Skipped');
/** What became of a waiting change once decided: "Approved by Ada", "Skipped", "Kept", or why it was not made. */
const decided = (change: AssistantChange) => change.state === 'skipped' || change.state === 'refused' && !skipped(change) && change.waitReason === null && !!change.line;

/** The owner's (and the conversation's visible) agent changes of this conversation, by run. */
export function useAssistantChanges(conversationId: string | null, refreshKey: unknown, enabled = true) {
  const [changes, setChanges] = useState<AssistantChange[]>([]);
  const refresh = useCallback(async () => {
    if (!conversationId || !enabled) { setChanges([]); return; }
    try { setChanges((await listConversationChanges(conversationId)).items); } catch { /* the conversation reports lost access itself */ }
  }, [conversationId, enabled]);
  useEffect(() => {
    // F-029 (#614): the changes of a workspace whose AI is off are not shown and not asked for.
    if (!conversationId || !enabled) return;
    let live = true;
    listConversationChanges(conversationId).then((page) => { if (live) setChanges(page.items); }).catch(() => undefined);
    return () => { live = false; };
  }, [conversationId, refreshKey, enabled]);
  const shown = useMemo(() => (enabled ? changes : []), [enabled, changes]);
  const byRun = useMemo(() => {
    const runs = new Map<string, AssistantChange[]>();
    for (const change of shown) if (waiting(change) || made(change) || skipped(change) || decided(change)) runs.set(change.runId, [...(runs.get(change.runId) ?? []), change]);
    return runs;
  }, [shown]);
  return { byRun, refresh };
}

/**
 * One run's changes, for the asker's own answer (#842): the change line with Undo, and what waits for them. `refreshKey` reads them again when
 * the run moves; a run with none shows nothing.
 */
export const readRunChanges = async (runId: string) => (await listRunChanges(runId)).items.filter((change) => waiting(change) || made(change) || skipped(change) || decided(change));

/** `initial` is what the page read already, so the card has its change line when it first appears and does not grow after. */
export function useRunChanges(runId: string | null, refreshKey: unknown, enabled = true, initial: AssistantChange[] = []) {
  const [changes, setChanges] = useState<AssistantChange[]>(initial);
  const read = useCallback(() => readRunChanges(runId!), [runId]);
  const refresh = useCallback(async () => {
    if (!runId || !enabled) return;
    try { setChanges(await read()); } catch { /* the answer is shown without its change line */ }
  }, [runId, enabled, read]);
  useEffect(() => {
    if (!runId || !enabled) return;
    let live = true;
    read().then((items) => { if (live) setChanges(items); }).catch(() => undefined);
    return () => { live = false; };
  }, [runId, enabled, read, refreshKey]);
  return { changes, refresh };
}

// Undo, Approve and Skip never fail silently offline: they say "Offline" (AST-10.15).
export const failure = (error: unknown) => error instanceof NetworkError ? 'Offline' : error instanceof ApiError && error.message ? error.message : 'Couldn’t reach Flux. Try again.';

/** "Changed since. Open it": the closing words open the object, when it has a place to open. */
function Said({ text, change }: { text: string; change: AssistantChange | undefined }) {
  const { openDetails } = useShellActions();
  const open = /\. (Open (?:it|the task))$/.exec(text);
  if (!open || !change?.objectId) return <>{text}</>;
  const head = text.slice(0, open.index + 1);
  const target = change.objectType === 'work' ? <button type="button" className="ui-link" onClick={() => openDetails({ kind: 'work', id: change.objectId! })}>{open[1]}</button>
    : change.objectType === 'doc' ? <RefLink className="ui-link" to={`/projects/${change.projectId}/docs/${change.objectId}`}>{open[1]}</RefLink> : null;
  return target ? <>{head} {target}</> : <>{text}</>;
}

/**
 * The change line on the agent's message (AG-3): "Updated the Wiki page Calibration (3 changes) · moved #4 to In progress · Undo".
 * Undo restores the earlier versions; the line is then struck through and ends "Undone by Ada". There is no separate Activity list.
 */
function ChangeLine({ changes, onChanged, meId, standalone }: { changes: AssistantChange[]; onChanged: () => Promise<void>; meId?: string; standalone: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; change?: AssistantChange } | null>(null);
  const { ref: home, keep } = useKeepFocus<HTMLElement>(() => document.getElementById(`answer-${changes[0]?.runId}`));
  const done = changes.filter(made);
  const skips = changes.filter(skipped);
  if (!done.length && !skips.length || changes[0]!.runState === 'working') return null;
  const runId = changes[0]!.runId;
  const live = done.filter((change) => change.state !== 'undone');
  const undoneBy = done.find((change) => change.state === 'undone' && change.decidedBy)?.decidedBy?.name;
  const owner = changes[0]!.owner;
  const whose = !meId || owner.id === meId ? 'your' : `${owner.name.trim().split(/\s+/)[0] || owner.name}’s`;
  const undo = () => keep(async () => {
    setBusy(true); setNote(null);
    try {
      const result = await undoRunChanges(runId);
      const refused = result.changes.find((entry) => entry.message && entry.change.state !== 'undone');
      if (result.changedSince.length) setNote({ text: refused?.message && result.changedSince.length === 1 ? refused.message : result.message, change: refused?.change });
    } catch (error) { setNote({ text: failure(error) }); }
    finally { setBusy(false); await onChanged(); }
  });
  return (
    <section ref={home} tabIndex={-1} className="assistant-message" aria-label={`What ${whose} assistant changed`} data-run={runId}>
      {standalone && whose !== 'your' ? <p className="assistant-message__who">{whose[0]!.toUpperCase()}{whose.slice(1)} assistant</p> : null}
      {done.length ? <p className="assistant-message__line" role="status" aria-live="polite">
        {live.length ? <span>{assistantChangeLine(live)}</span> : <s>{assistantChangeLine(done)}</s>}
        {live.length && live.some((change) => change.undoable) ? <><span aria-hidden="true"> · </span>
          <Button variant="link" busy={busy} onClick={() => void undo()}>Undo</Button></> : null}
        {!live.length ? <><span aria-hidden="true"> · </span><span>Undone by {undoneBy ?? 'you'}</span></> : null}
      </p> : null}
      {note ? <p className="assistant-message__note" role="status"><Said text={note.text} change={note.change} /></p> : null}
      {skips.map((change) => <p key={change.id} className="assistant-message__note">{change.line}</p>)}
    </section>
  );
}

/** Who would read what, for a change that would notify people (#1089, #1102): "Jonas and Maja would read: …", in three lines with "Show all". */
function ToldWords({ change }: { change: AssistantChange }) {
  // A change read before #1102 (a cached page) may carry no list: nobody is named then.
  const told = change.tells ?? [];
  if (!told.length || !change.after) return null;
  return <div className="assistant-waiting__said"><span>{peopleNamed(told)} would read:</span> <ClampedWords text={change.after} /></div>;
}

/** One waiting change as a card: a deletion asks [Delete] [Keep]; a task for another person [Approve] [Edit] [Skip]. */
function WaitingCard({ change, agent, busy, onAct, editing, onEdit }: {
  change: AssistantChange; agent: string; busy: string; onAct: (key: string, action: () => Promise<unknown>) => void;
  editing: boolean; onEdit: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(change.objectTitle);
  const removal = change.waitReason === 'removal';
  const proposal = !!change.forPerson;
  const noun = change.phrase.split(' ').pop() ?? 'item';
  const what = removal ? <>{agent} wants to delete the {noun} {change.objectTitle ? <b>{change.objectTitle}</b> : null}</>
    : proposal ? <>{agent} wants to create <b>{change.objectTitle}</b> for {change.forPerson!.name}</>
    : <>{agent} wants to {change.phrase} {change.objectTitle ? <b>{change.objectTitle}</b> : null}</>;
  return (
    <li className="assistant-waiting__card" data-change={change.id}>
      <p className="assistant-waiting__what">{what}</p>
      {/* What Flux would send the person, before the OK (#1089): the title and blocker, or the decision's title. On a task for
          someone else it names the third person it would tell. Long words take three lines and "Show all". */}
      <ToldWords change={change} />
      {change.line ? <p className="assistant-waiting__why">{change.line}</p> : null}
      {editing ? <form className="assistant-waiting__edit" onSubmit={(event) => { event.preventDefault(); onAct(`edit:${change.id}`, async () => { await editChange(change, title.trim()); onEdit(false); }); }}>
        <label className="ui-vh" htmlFor={`edit-${change.id}`}>Task title</label>
        <input id={`edit-${change.id}`} value={title} maxLength={WORK_LIMITS.title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <Button type="submit" variant="secondary" busy={busy === `edit:${change.id}`} disabled={!title.trim() || !!busy}>Save</Button>
        <Button variant="quiet" disabled={!!busy} onClick={() => { setTitle(change.objectTitle); onEdit(false); }}>Cancel</Button>
      </form> : <div className="assistant-proposal__actions">
        <Button variant="primary" busy={busy === `apply:${change.id}`} disabled={!!busy} onClick={() => onAct(`apply:${change.id}`, () => applyChange(change))}>{removal ? 'Delete' : 'Approve'}</Button>
        {proposal ? <Button variant="secondary" disabled={!!busy} onClick={() => onEdit(true)}>Edit</Button> : null}
        <Button variant="quiet" busy={busy === `skip:${change.id}`} disabled={!!busy} onClick={() => onAct(`skip:${change.id}`, () => skipChange(change))}>{removal ? 'Keep' : 'Skip'}</Button>
      </div>}
    </li>
  );
}

/** Tasks the agent proposes for other people, together: each with [Edit] [Skip], and Approve all for the group. */
function ProposalGroup({ changes, agent, busy, onAct, editing, onEdit }: {
  changes: AssistantChange[]; agent: string; busy: string; onAct: (key: string, action: () => Promise<unknown>) => void;
  editing: string | null; onEdit: (id: string | null) => void;
}) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  return (
    <li className="assistant-waiting__card">
      <p className="assistant-waiting__what">{agent} wants to create {changes.length} tasks for others</p>
      <ul className="assistant-waiting__list">
        {changes.map((change) => editing === change.id ? (
          <li key={change.id}><form className="assistant-waiting__edit" onSubmit={(event) => { event.preventDefault();
            onAct(`edit:${change.id}`, async () => { await editChange(change, (titles[change.id] ?? change.objectTitle).trim()); onEdit(null); }); }}>
            <label className="ui-vh" htmlFor={`edit-${change.id}`}>Task title</label>
            <input id={`edit-${change.id}`} value={titles[change.id] ?? change.objectTitle} maxLength={WORK_LIMITS.title} autoFocus
              onChange={(event) => setTitles((current) => ({ ...current, [change.id]: event.target.value }))} />
            <Button type="submit" variant="secondary" busy={busy === `edit:${change.id}`} disabled={!(titles[change.id] ?? change.objectTitle).trim() || !!busy}>Save</Button>
            <Button variant="quiet" disabled={!!busy} onClick={() => onEdit(null)}>Cancel</Button>
          </form></li>
        ) : (
          <li key={change.id} data-change={change.id}>
            <span className="assistant-waiting__task"><b>{change.objectTitle}</b><small>for {change.forPerson?.name ?? 'someone'}</small><ToldWords change={change} /></span>
            <Button variant="link" disabled={!!busy} onClick={() => onEdit(change.id)}>Edit</Button>
            <Button variant="link" busy={busy === `skip:${change.id}`} disabled={!!busy} onClick={() => onAct(`skip:${change.id}`, () => skipChange(change))}>Skip</Button>
          </li>
        ))}
      </ul>
      <p className="assistant-waiting__why">Tasks for other people wait for your OK.</p>
      <div className="assistant-proposal__actions">
        <Button variant="primary" busy={busy === 'group'} disabled={!!busy || editing !== null} onClick={() => onAct('group', async () => {
          const results: { message: string | null }[] = [];
          for (const change of changes) {
            try { results.push(await applyChange(change)); } catch (error) { results.push({ message: failure(error) }); }
          }
          return { changes: results };
        })}>Approve all</Button>
      </div>
    </li>
  );
}

/** One run's message: the change line with Undo for everyone who can read it, then what waits for its owner. */
export function WaitingChanges({ changes, onChanged, meId, standalone = false }: { changes: AssistantChange[]; onChanged: () => Promise<void>; meId?: string;
  /** Not under the assistant's own answer: the message names whose assistant it is itself. */
  standalone?: boolean }) {
  const pending = changes.filter(waiting);
  const proposals = pending.filter((change) => !!change.forPerson);
  const singles = proposals.length > 1 ? pending.filter((change) => !change.forPerson) : pending;
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const runId = changes[0]!.runId;
  const agent = 'Assistant';
  // A decided card goes away; focus stays in the run's waiting list, or else on its message or answer (AC-8).
  const { ref: home, keep } = useKeepFocus<HTMLElement>(() => document.querySelector<HTMLElement>(`.assistant-message[data-run="${runId}"]`) ?? document.getElementById(`answer-${runId}`));
  const act = (key: string, action: () => Promise<unknown>) => void keep(async () => {
    setBusy(key); setMessages([]);
    try {
      const result = await action() as { changes?: { message: string | null }[]; message?: string | null } | undefined;
      setMessages([...(result?.changes ?? []).map((entry) => entry.message), result?.message ?? null].filter((message): message is string => !!message));
    } catch (error) { setMessages([failure(error)]); }
    finally { setBusy(''); await onChanged(); }
  });
  const settled = changes.filter(decided);
  return (<>
    <ChangeLine changes={changes} onChanged={onChanged} meId={meId} standalone={standalone} />
    {pending.length || settled.length || messages.length ? <section ref={home} tabIndex={-1} className="assistant-waiting" aria-label="Waiting for your OK" data-run={runId}>
      {pending.length ? <ul className="assistant-waiting__cards">
        {singles.map((change) => <WaitingCard key={change.id} change={change} agent={agent} busy={busy} onAct={act}
          editing={editing === change.id} onEdit={(open) => setEditing(open ? change.id : null)} />)}
        {proposals.length > 1 ? <ProposalGroup changes={proposals} agent={agent} busy={busy} onAct={act} editing={editing} onEdit={setEditing} /> : null}
      </ul> : null}
      {settled.map((change) => <p key={change.id} className="assistant-waiting__done">
        {change.state === 'skipped' ? `${change.line}: ${change.phrase}${change.objectTitle ? ` ${change.objectTitle}` : ''}` : change.line}
      </p>)}
      {messages.length ? <p className="assistant-answer__error" role="alert">{[...new Set(messages)].join(' · ')}</p> : null}
    </section> : null}
  </>);
}
