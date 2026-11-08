import { useState } from 'react';
import { type AssistantRun } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useShellData } from '../app/data';
import { Button, Icon, Kreska } from '../ui';
import { AnswerBody, BehindLine, sourceSummary, WorkingLine, type SourceLookups } from './ConversationParts';
import type { ConversationAssistant } from './useConversationAssistant';
import { useRunChanges, WaitingChanges } from './WaitingChanges';
import './assistant.css';

// The answer to `/ai` (#842, F-036 AG-4; mockup AiPrivate): a card only its asker sees, in the place they asked. Show everyone posts it as their
// own message, "Ada · via Assistant"; Dismiss puts it away. Nothing about it reaches anyone else until then. While the agent works, or when a run
// ends without an answer, the owner-only working line stands in the same place.

/** "Jonas and Maja", "Jonas, Maja and 3 others": who does not see the answer. */
export function othersWords(names: readonly string[]): string {
  if (!names.length) return 'Nobody else';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** The first names of the other people who read a place: the ones who do not see a private answer. */
export const firstNames = (names: readonly string[]) => names.map(firstName);

function problem(error: unknown, shown: boolean): string {
  if (error instanceof NetworkError) return 'Offline';
  if (error instanceof ApiError && error.status === 404) return 'You can no longer write here, so this can’t be shown.';
  if (error instanceof ApiError && error.status === 403) return 'AI is off in this space, so this can’t be shown.';
  return shown ? 'Couldn’t show it. Try again.' : 'Couldn’t put it away. Try again.';
}

export function PrivateAnswer({ run, assistant, meId, meName, others, composerId, lookups, refreshKey }: {
  run: AssistantRun; assistant: ConversationAssistant; meId: string; meName: string;
  /** First names of the other people who read this place, or none when nobody else does. */
  others: readonly string[]; composerId?: string; lookups: SourceLookups; refreshKey: unknown;
}) {
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === run.agentId);
  const name = run.answer!.assistant.label;
  const [busy, setBusy] = useState<'' | 'show' | 'dismiss'>('');
  const [failed, setFailed] = useState('');
  const { changes, refresh } = useRunChanges(run.id, refreshKey, run.projectId !== null, assistant.changesOf(run.id));
  const toTheBox = () => { if (composerId) requestAnimationFrame(() => document.getElementById(composerId)?.focus({ preventScroll: true })); };
  async function act(kind: 'show' | 'dismiss') {
    setBusy(kind); setFailed('');
    try { await (kind === 'show' ? assistant.show(run) : assistant.dismissPrivate(run)); toTheBox(); }
    catch (error) { setFailed(problem(error, kind === 'show')); }
    finally { setBusy(''); }
  }
  const answer = run.answer!;
  return (
    <li id={`answer-${run.id}`} tabIndex={-1} className="assistant-private" role="note" aria-label="Private answer" data-answer-run={run.id} data-private-answer="">
      <div className="assistant-private__who">
        <Kreska size={24} {...(agent ? { hue: agent.colour } : {})} />
        <strong>{name}</strong>
        <span className="assistant-private__lock"><Icon name="lock" size={13} />Only you can see this</span>
      </div>
      <p className="assistant-private__asked">You asked: <code>/ai</code> {run.prompt}</p>
      <AnswerBody answer={answer} lookups={lookups} />
      {answer.truncated ? <p className="assistant-answer__truncated"><Icon name="alert" size={13} />Stopped at the length limit, so this answer is incomplete.</p> : null}
      {changes.length ? <WaitingChanges changes={changes} onChanged={refresh} meId={meId} /> : null}
      {answer.sources.length ? <p className="assistant-private__source">{sourceSummary(answer.sources.length, run.dmThreadRootId ? 'this thread' : run.dmId ? 'this conversation' : 'this space')}</p> : null}
      <div className="assistant-private__foot">
        <span className="assistant-private__note">
          {others.length ? `${othersWords(others)} ${others.length === 1 ? 'doesn’t' : 'don’t'} see this. ` : ''}Show everyone posts it as “{firstName(meName)} · via {name}”.
        </span>
        <Button variant="quiet" busy={busy === 'dismiss'} disabled={!!busy} onClick={() => void act('dismiss')}>Dismiss</Button>
        <Button variant="primary" busy={busy === 'show'} disabled={!!busy} onClick={() => void act('show')}>Show everyone</Button>
      </div>
      {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
    </li>
  );
}

/**
 * What the asker's own agent is doing in this place, and what it answered: the working line, the request waiting behind it, and the
 * private answers. List items, for the place's own list.
 */
export function PrivateAiLines({ assistant, meId, meName, others, composerId, lookups, changed = 0, own = false }: {
  assistant: ConversationAssistant; meId: string; meName: string; others: readonly string[]; composerId?: string; lookups: SourceLookups;
  /** Changes the working run made before it ended, for its line. */
  changed?: number;
  /** In a list of their own, only when there is something to show: for a place that has no list for it (the stream). */
  own?: boolean;
}) {
  const { run, queued, privateAnswers, tick } = assistant;
  if (own && !run && !queued && !privateAnswers.length) return null;
  const items = <>
    {privateAnswers.map((answered) => <PrivateAnswer key={answered.id} run={answered} assistant={assistant} meId={meId} meName={meName} others={others} composerId={composerId} lookups={lookups} refreshKey={tick} />)}
    {run ? <WorkingLine key="assistant-working" run={run} onStop={assistant.stop} onRetry={() => assistant.retry(run.id)} onDismiss={assistant.dismissRun} {...(composerId ? { composerId } : {})} changed={changed} /> : null}
    {queued?.behind && queued.behind.authority !== 'owner_request' ? <BehindLine label={queued.behind.label} onStop={assistant.stopBehind} />
      : queued ? <li className="assistant-queued" aria-live="polite">Next: “{queued.prompt.length > 60 ? `${queued.prompt.slice(0, 60)}…` : queued.prompt}”. It starts when this one ends ·
        <Button variant="link" onClick={() => void assistant.cancelQueued().catch(() => undefined)}>Cancel</Button></li> : null}
  </>;
  return own ? <ol className="project-convo__message-list assistant-private-list" aria-label="Your assistant">{items}</ol> : items;
}
