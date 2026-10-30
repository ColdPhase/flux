import type { ReactNode } from 'react';
import type { ConversationMessage, ProjectPerson } from '@flux/contracts';
import type { ComposerState, outboxView } from '../composer/draft';
import { BehindLine, OthersWorkingLine, WorkingLine } from '../assistant/ConversationParts';
import { WaitingChanges } from '../assistant/WaitingChanges';
import { MessageDay, day, sameMessageAuthor } from '../app/messageParts';
import { ObjectNoticeItem } from '../app/ObjectNotices';
import type { ShellActions } from '../app/shellContext';
import type { AgentOwners } from '../agents/owners';
import { Button } from '../ui';
import type { useCreateWorkFromMessage } from '../work/inline';
import type { PaneProps } from '../app/OneConversation';
import type { FeedEntry } from './feed';
import type { PaneCore } from './paneCore';
import { answerElements, type AnswerContext } from './ThreadAnswers';
import { ThreadReply } from './ThreadReply';
import type { ThreadReading } from './useThreadReading';
import type { ThreadReplies } from './useThreadReplies';

interface Props {
  core: PaneCore; thread: ThreadReplies; reading: ThreadReading; entries: FeedEntry[]; outbox: ReturnType<typeof outboxView>;
  publicComposer: ComposerState; answers: AnswerContext; owners: AgentOwners; people: ProjectPerson[] | null;
  makeWork: ReturnType<typeof useCreateWorkFromMessage>; arrived: string | null; seen: Map<string, { name: string }[]>;
  messageAuthor: (message: ConversationMessage) => string; openDetails: ShellActions['openDetails']; hideIfDenied: (cause: unknown) => void;
  waitingHere: { clientRunId: string }[]; rootHeader: PaneProps['rootHeader']; rootMessageId: string | null;
}

/** The open thread (UI116-1): its root whole at the top, then replies, answers and what came of them, in time order. */
export function ThreadFeed(props: Props) {
  const { core: { me, project, writable, composerId }, thread, reading, entries, outbox, answers, owners, arrived, seen } = props;
  const { assistant, changes } = answers;
  const { attachFeed, liftRef, columnRef, revealed, messageWork, discussedRow } = reading;
  // Every entry, then every queued reply, with a day line where the day changes (a folded answer still counts as its day).
  const rows: { at: string; key: string; items: ReactNode[] }[] = [];
  const withDay = (at: string, key: string, items: ReactNode[]) => { rows.push({ at, key, items }); };
  entries.forEach((entry, index) => {
    const dayKey = `day-${entry.type === 'message' ? outbox.keyOf(entry.message.id) : entry.key}`;
    if (entry.type === 'object') withDay(entry.at, dayKey, [<ObjectNoticeItem key={entry.key} notice={entry.notice} meId={me.user.id} owners={owners} authorOf={() => null} inThread
      hasMessage={() => false} onOpen={(target) => props.openDetails(target)} />]);
    else if (entry.type === 'answer') withDay(entry.at, dayKey, answerElements(entry, index, entries, answers));
    else {
      const message = entry.message;
      const previous = entries[index - 1], next = entries[index + 1];
      const continued = previous?.type === 'message' && sameMessageAuthor(previous.message, message);
      const nextMessage = next?.type === 'message' ? next.message : !next && outbox.pending[0] ? { authorId: me.user.id, createdAt: outbox.pending[0].at } : undefined;
      const groupLast = !sameMessageAuthor(message, nextMessage);
      // A reply confirmed from its queued message keeps that list item: it does not move or arrive twice (#264).
      withDay(entry.at, dayKey, [<ThreadReply key={outbox.keyOf(message.id)} continued={continued} groupLast={groupLast} message={message} mine={message.authorId === me.user.id} meId={me.user.id} arrived={arrived === message.id} name={props.messageAuthor(message)}
        project={project} owners={owners} people={props.people} preview={messageWork.previews?.get(message.id) ?? null} makeWork={props.makeWork} writable={writable}
        onOpenResult={(resultId) => props.openDetails({ kind: 'result', id: resultId })} onDenied={props.hideIfDenied}
        observed={message.authorId !== me.user.id} seenBy={(seen.get(message.id) ?? []).map((person) => person.name)} />]);
    }
  });
  outbox.pending.forEach((item, index) => {
    const previous = index ? { authorId: me.user.id, createdAt: outbox.pending[index - 1]!.at } : entries.at(-1)?.type === 'message' ? thread.messages.at(-1) : undefined;
    const continued = sameMessageAuthor(previous, { authorId: me.user.id, createdAt: item.at });
    withDay(item.at, `day-pending-${item.id}`, [<ThreadReply key={`pending-${item.id}`} continued={continued} pending={item} name={me.user.name} onRetry={() => props.publicComposer.retry(item.id)} onRemove={() => props.publicComposer.remove(item.id)} />]);
  });
  const list = rows.flatMap((row, index) => !row.items.length ? [] : day(row.at) !== (index ? day(rows[index - 1]!.at) : '')
    ? [<MessageDay key={row.key} label={day(row.at)} />, ...row.items] : row.items);
  return <div className={`thread__feed${revealed ? '' : ' is-opening'}`} ref={attachFeed} aria-busy={revealed ? undefined : true}>
    <div className="thread__lift" aria-hidden="true" ref={liftRef} />
    <div className="thread__in" ref={columnRef}>
      {props.rootHeader?.({ preview: props.rootMessageId ? messageWork.previews?.get(props.rootMessageId) ?? null : null, taskRow: discussedRow })}
      <section aria-label="Replies to this message" className="project-convo__messages">
        {thread.olderCursor ? <Button variant="quiet" busy={thread.olderBusy} onClick={() => void thread.loadOlder()}>Load earlier replies</Button> : null}
        <ol className="thread__list">{list}
        {[...changes.byRun].filter(([runId]) => !assistant.answers.some((answer) => answer.runId === runId)).map(([runId, runChanges]) => (
          <li key={`changes-${runId}`} className="project-convo__message assistant-waiting-item"><WaitingChanges changes={runChanges} onChanged={changes.refresh} meId={me.user.id} standalone /></li>
        ))}
        {assistant.run ? <WorkingLine key="assistant-working" run={assistant.run} onStop={assistant.stop} onRetry={() => assistant.retry(assistant.run!.id)} onDismiss={assistant.dismissRun} composerId={composerId}
          changed={(changes.byRun.get(assistant.run.id) ?? []).filter((change) => change.state === 'applied' || change.state === 'applied_after_wait' || change.state === 'undone').length} /> : null}
        {assistant.others.map((other) => <OthersWorkingLine key={`working-${other.ownerId}`} name={other.ownerName} />)}
        {props.waitingHere.map((item) => <li key={item.clientRunId} className="assistant-queued" aria-live="polite">Sends when you&apos;re back</li>)}
        {assistant.queued?.behind && assistant.queued.behind.authority !== 'owner_request' ? <BehindLine label={assistant.queued.behind.label} onStop={assistant.stopBehind} />
          : assistant.queued ? <li className="assistant-queued" aria-live="polite">Next: “{assistant.queued.prompt.length > 60 ? `${assistant.queued.prompt.slice(0, 60)}…` : assistant.queued.prompt}”. It starts when this one ends ·
          <Button variant="link" onClick={() => void assistant.cancelQueued().catch(() => undefined)}>Cancel</Button></li> : null}
        </ol>
      </section>
    </div>
  </div>;
}
