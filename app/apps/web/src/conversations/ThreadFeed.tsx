import type { ReactNode } from 'react';
import type { ConversationMessage, ProjectPerson } from '@flux/contracts';
import type { ComposerState, outboxView } from '../composer/draft';
import type { SourceLookups } from '../assistant/ConversationParts';
import { PrivateAiLines } from '../assistant/PrivateAiLines';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import { WaitingChanges, type useAssistantChanges } from '../assistant/WaitingChanges';
import { MessageDay, day, sameMessageAuthor } from '../app/messageParts';
import type { Receipt } from '../app/receipts';
import { ObjectNoticeItem } from '../app/ObjectNotices';
import { followsProposal } from '../app/objectNotices';
import type { ShellActions } from '../app/shellContext';
import type { AgentOwners } from '../agents/owners';
import { Button, OpeningRows } from '../ui';
import type { useCreateWorkFromMessage } from '../work/inline';
import type { PaneProps } from '../app/OneConversation';
import type { FeedEntry } from './feed';
import type { PaneCore } from './paneCore';
import { ThreadReply } from './ThreadReply';
import { NewBelow, UnreadDivider } from '../app/unreadReading';
import type { ThreadReading } from './useThreadReading';
import type { ThreadReplies } from './useThreadReplies';

/** The signed-in person's own assistant in this thread: its working line and its private answers, which only they see (#842). */
export interface PrivateAiContext {
  assistant: ReturnType<typeof useConversationAssistant>; changes: ReturnType<typeof useAssistantChanges>;
  /** The first names of the other people who read this place: they do not see the asker's private answer (#842). */
  others: string[];
  /** Where a private answer's citations point. */
  lookups: SourceLookups;
}

interface Props {
  core: PaneCore; thread: ThreadReplies; reading: ThreadReading; entries: FeedEntry[]; outbox: ReturnType<typeof outboxView>;
  publicComposer: ComposerState; privateAi: PrivateAiContext; owners: AgentOwners; people: ProjectPerson[] | null;
  makeWork: ReturnType<typeof useCreateWorkFromMessage>; arrived: string | null; seen: Map<string, Receipt>;
  messageAuthor: (message: ConversationMessage) => string; openDetails: ShellActions['openDetails']; hideIfDenied: (cause: unknown) => void;
  waitingHere: { clientRunId: string }[]; rootHeader: PaneProps['rootHeader']; rootMessageId: string | null;
  /** The reply the "New" divider stands above, and the "↓ N new" line for a reader above the end (#1246). */
  unreadFrom: string | null; newBelow: { count: number; toEnd: () => void };
}

/** The open thread (UI116-1): its root whole at the top, then replies and what came of them, in time order, and the person's own private answers at the end. */
export function ThreadFeed(props: Props) {
  const { core: { me, project, writable, composerId }, thread, reading, entries, outbox, privateAi, owners, arrived, seen } = props;
  const { assistant, changes } = privateAi;
  const { attachFeed, columnRef, revealed, messageWork, discussedRow } = reading;
  // Every entry, then every queued reply, with a day line where the day changes.
  const rows: { at: string; key: string; items: ReactNode[] }[] = [];
  const withDay = (at: string, key: string, items: ReactNode[]) => { rows.push({ at, key, items }); };
  entries.forEach((entry, index) => {
    const dayKey = `day-${entry.type === 'message' ? outbox.keyOf(entry.message.id) : entry.key}`;
    if (entry.type === 'object') withDay(entry.at, dayKey, [<ObjectNoticeItem key={entry.key} notice={entry.notice} meId={me.user.id} owners={owners} authorOf={() => null} inThread
      follows={(() => { const previous = entries[index - 1]; return previous?.type === 'object' && day(previous.at) === day(entry.at) && followsProposal(entry.notice, previous.notice); })()}
      hasMessage={() => false} onOpen={(target) => props.openDetails(target)} />]);
    else {
      const message = entry.message;
      const previous = entries[index - 1], next = entries[index + 1];
      // The reply the "New" divider stands above starts a group, as after a day line: its author is named again, and the reply before it ends its group.
      const continued = message.id !== props.unreadFrom && previous?.type === 'message' && sameMessageAuthor(previous.message, message);
      const nextMessage = next?.type === 'message' ? next.message : !next && outbox.pending[0] ? { authorId: me.user.id, createdAt: outbox.pending[0].at } : undefined;
      const groupLast = (next?.type === 'message' && next.message.id === props.unreadFrom) || !sameMessageAuthor(message, nextMessage);
      // A reply confirmed from its queued message keeps that list item: it does not move or arrive twice (#264).
      withDay(entry.at, dayKey, [...(message.id === props.unreadFrom ? [<UnreadDivider key="unread" />] : []), <ThreadReply key={outbox.keyOf(message.id)} continued={continued} groupLast={groupLast} message={message} mine={message.authorId === me.user.id} meId={me.user.id} arrived={arrived === message.id} name={props.messageAuthor(message)}
        project={project} owners={owners} people={props.people} preview={messageWork.previews?.get(message.id) ?? null} makeWork={props.makeWork} writable={writable} onDenied={props.hideIfDenied}
        observed={message.authorId !== me.user.id} receipt={seen.get(message.id)} />]);
    }
  });
  outbox.pending.forEach((item, index) => {
    const previous = index ? { authorId: me.user.id, createdAt: outbox.pending[index - 1]!.at } : entries.at(-1)?.type === 'message' ? thread.messages.at(-1) : undefined;
    const continued = sameMessageAuthor(previous, { authorId: me.user.id, createdAt: item.at });
    withDay(item.at, `day-pending-${item.id}`, [<ThreadReply key={`pending-${item.id}`} continued={continued} pending={item} name={me.user.name} onRetry={() => props.publicComposer.retry(item.id)} onRemove={() => props.publicComposer.remove(item.id)} />]);
  });
  // The first replies' day joins the root's "3 replies" line ("3 replies · Today", #763 A5): one separator, not two.
  const firstDay = props.rootHeader && entries[0]?.type === 'message' && rows[0] ? day(rows[0].at) : null;
  const list = rows.flatMap((row, index) => !row.items.length ? [] : day(row.at) !== (index ? day(rows[index - 1]!.at) : '') && !(index === 0 && firstDay)
    ? [<MessageDay key={row.key} label={day(row.at)} />, ...row.items] : row.items);
  return <div className="convo-stream">
  {/* The replies are laid out but hidden until their first reads settle (#155); quiet rows stand in their place from the first frame (#863 rule 6), so the panel never opens empty. */}
  {revealed ? null : <div className="thread__opening"><OpeningRows rows={Math.min(4, Math.max(2, thread.messages.length))} /></div>}
  <div className={`thread__feed${revealed ? '' : ' is-opening'}`} ref={attachFeed} aria-busy={revealed ? undefined : true}>
    <div className="thread__in" ref={columnRef}>
      {props.rootHeader?.({ preview: props.rootMessageId ? messageWork.previews?.get(props.rootMessageId) ?? null : null, taskRow: discussedRow, firstDay })}
      <section aria-label="Replies to this message" className="project-convo__messages">
        {thread.olderCursor ? <Button variant="quiet" busy={thread.olderBusy} onClick={() => void thread.loadOlder()}>Load earlier replies</Button> : null}
        <ol className="thread__list">{list}
        {[...changes.byRun].filter(([runId]) => !assistant.privateAnswers.some((answered) => answered.id === runId)).map(([runId, runChanges]) => (
          <li key={`changes-${runId}`} className="project-convo__message assistant-waiting-item"><WaitingChanges changes={runChanges} onChanged={changes.refresh} meId={me.user.id} standalone /></li>
        ))}
        <PrivateAiLines assistant={assistant} meId={me.user.id} meName={me.user.name} others={privateAi.others} composerId={composerId} lookups={privateAi.lookups}
          changed={(changes.byRun.get(assistant.run?.id ?? '') ?? []).filter((change) => change.state === 'applied' || change.state === 'applied_after_wait' || change.state === 'undone').length} />
        {props.waitingHere.map((item) => <li key={item.clientRunId} className="assistant-queued" aria-live="polite">Sends when you&apos;re back</li>)}
        </ol>
      </section>
    </div>
  </div>
  <NewBelow count={props.newBelow.count} onClick={props.newBelow.toEnd} />
  </div>;
}
