import { useState } from 'react';
import { type AssistantRun } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useShellData } from '../app/data';
import { Button, Icon, Kreska } from '../ui';
import { AnswerBody, AnswerTools, BehindLine, sourceSummary, WorkingLine, WritingAnswer, type SourceLookups } from './ConversationParts';
import { isWorking } from './format';
import { useForgetLiveRun, useLiveRun } from './liveRun';
import type { ConversationAssistant } from './useConversationAssistant';
import { useRunChanges, WaitingChanges } from './WaitingChanges';
import { PhotoGrid } from '../composer/Attachments';
import './assistant.css';

// The answer to `/ai` (#842, F-036 AG-4; mockup AiPrivate): a card only its asker sees, in the place they asked. Show everyone posts it as their
// message, labelled "Ada's Assistant" with the agent's Kreska (#1232); Dismiss puts it away. Nothing about it reaches anyone else until then. While the agent works, or when a run
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
  // The pictures its agent attached (#1217): the asker's alone until Show everyone posts them with the answer, shown as a message's photos are.
  const pictures = changes.flatMap((change) => (change.file && (change.state === 'applied' || change.state === 'applied_after_wait') ? [change.file] : []));
  useForgetLiveRun(run.id, true);
  return (
    <li id={`answer-${run.id}`} tabIndex={-1} className="assistant-private" role="note" aria-label="Private answer" data-answer-run={run.id} data-private-answer="">
      <div className="assistant-private__who">
        <Kreska size={24} {...(agent ? { hue: agent.colour } : {})} />
        <strong>{name}</strong>
        <span className="assistant-private__lock"><Icon name="lock" size={13} />Only you can see this</span>
      </div>
      <p className="assistant-private__asked">You asked: <code>/ai</code> {run.prompt}</p>
      <AnswerBody answer={answer} lookups={lookups} />
      {pictures.length ? <PhotoGrid photos={pictures} context={{ author: name }} /> : null}
      {answer.truncated ? <p className="assistant-answer__truncated"><Icon name="alert" size={13} />Stopped at the length limit, so this answer is incomplete.</p> : null}
      {run.status === 'stopped' ? <p className="assistant-answer__truncated" data-stopped-answer=""><Icon name="alert" size={13} />Stopped by you, so this answer is incomplete.</p> : null}
      <AnswerTools answer={answer} onRetry={() => assistant.retry(run.id)} />
      {changes.length ? <WaitingChanges changes={changes} onChanged={refresh} meId={meId} /> : null}
      {answer.sources.length ? <p className="assistant-private__source">{sourceSummary(answer.sources.length, run.dmThreadRootId ? 'this thread' : run.dmId ? 'this conversation' : 'this space')}</p> : null}
      <div className="assistant-private__foot">
        <span className="assistant-private__note">
          {others.length ? `${othersWords(others)} ${others.length === 1 ? 'doesn’t' : 'don’t'} see this. ` : ''}Show everyone posts it as “{firstName(meName)}'s {name}”.
        </span>
        <Button variant="quiet" busy={busy === 'dismiss'} disabled={!!busy} onClick={() => void act('dismiss')}>Dismiss</Button>
        <Button variant="primary" busy={busy === 'show'} disabled={!!busy} onClick={() => void act('show')}>Show everyone</Button>
      </div>
      {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
    </li>
  );
}

/** The working run's line: the working line, or, once its words come (#1248), the card where they are written. */
function RunLine({ run, assistant, composerId, changed, lookups }: { run: AssistantRun; assistant: ConversationAssistant; composerId: string | undefined; changed: number; lookups: SourceLookups }) {
  const live = useLiveRun(isWorking(run) ? run.id : null);
  if (isWorking(run) && run.status === 'dispatching' && live.text.trim()) return <WritingAnswer run={run} text={live.text} onStop={assistant.stop} people={lookups.people ?? null} />;
  return <WorkingLine run={run} onStop={assistant.stop} onRetry={() => assistant.retry(run.id)} onDismiss={assistant.dismissRun} {...(composerId ? { composerId } : {})} changed={changed} />;
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
    {run ? <RunLine key="assistant-working" run={run} assistant={assistant} composerId={composerId} changed={changed} lookups={lookups} /> : null}
    {queued?.behind && queued.behind.authority !== 'owner_request' ? <BehindLine label={queued.behind.label} onStop={assistant.stopBehind} />
      : queued ? <li className="assistant-queued" aria-live="polite">Next: “{queued.prompt.length > 60 ? `${queued.prompt.slice(0, 60)}…` : queued.prompt}”. It starts when this one ends ·
        <Button variant="link" onClick={() => void assistant.cancelQueued().catch(() => undefined)}>Cancel</Button></li> : null}
  </>;
  return own ? <ol className="project-convo__message-list assistant-private-list" aria-label="Your assistant">{items}</ol> : items;
}
