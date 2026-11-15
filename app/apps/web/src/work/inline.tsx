import { createContext, useCallback, useContext } from 'react';
import { useNavigate } from 'react-router';
import { messagePreview, type ConversationMessage, type NativeWorkRow, type Project, type WorkRowProjection } from '@flux/contracts';
import { Avatar, Icon, Kreska, StatusGlyph } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { decisionPieces, firstClause, firstLine, STATUS_LABEL, taskNumber, workPieces, type StatePiece } from './format';
import type { MessageWorkPreview } from './message-associations';
import './work.css';

// Work objects inside the conversation (#101, C direction): the quiet actions of a message and
// the framed objects that were made from it.

/**
 * The task a thread discusses (UI116-3), with its current title and state from the visible reference
 * read (#155: never the whole project's work); it opens the task in Details. Until that read answers,
 * the title stored with the thread is shown.
 */
export function DiscussedTask({ task, row }: { task: { workId: string; title: string; number?: number }; row: NativeWorkRow | null }) {
  const { openDetails } = useShellActions();
  const item = row?.kind === 'work' && row.id === task.workId ? row : null;
  // The root carries the immutable number, so the chip does not grow when the reference row arrives (#367).
  return <ObjectChip icon="tasks" number={item?.number ?? task.number} state={item ? workPieces(item) : [{ text: 'Task' }]} title={item?.title ?? task.title} label={(item?.number ?? task.number) ? `Discussion of task #${item?.number ?? task.number}` : 'Discussion of task'}
    objectKind="work" objectId={task.workId} nativeRef={`work:${task.workId}`} onOpen={() => openDetails({ kind: 'work', id: task.workId })} />;
}

/** A calm chip under a message for an object made from it: icon, title and a quiet state. */
function ObjectChip({ icon, number, state, title, need, onOpen, label, objectKind, objectId, nativeRef }: { icon: 'tasks' | 'flag' | 'map'; number?: number; state: StatePiece[]; title: string; need?: boolean; onOpen: () => void; label: string; objectKind: string; objectId: string; nativeRef?: string }) {
  return (
    <button type="button" data-work-kind={objectKind} data-work-id={objectId} data-native-ref={nativeRef} className={`ws-chip${need ? ' ws-chip--need' : ''}`} onClick={onOpen} aria-label={`${label}: ${title}`}>
      <Icon name={icon} size={14} />
      {number !== undefined ? <span className="ws-chip__num ui-task-number">{taskNumber({ number })}</span> : null}
      <span className="ws-chip__t">{title}</span>
      <span className="ws-chip__k">{state.map((piece, index) => <span key={index} className={piece.extra ? 'ws-chip__x' : undefined}>{piece.text}</span>)}</span>
    </button>
  );
}

/**
 * A task as the conversation's card draws it (#1424): its state glyph, `#1`, its whole title, its owner's face and name (or "No owner")
 * and its state word, opening it in the one panel. `row` is the task's current row from the visible reference read; until it answers,
 * the title and number it was announced with stand, with no owner. Where the card is narrow the owner's name gives way first.
 */
export function TaskObjectRow({ workId, number, title, row, reverted = false, onOpen }: { workId: string; number: number; title: string; row: WorkRowProjection | null; reverted?: boolean; onOpen: () => void }) {
  const owner = row?.owner ?? null;
  return (
    <button type="button" className="convo-notice__task" data-native-ref={`work:${workId}`} onClick={onOpen} aria-label={`Open task #${number} ${title}`}>
      <StatusGlyph status={row?.status} size={16} />
      {/* The immutable announcement number names the task before and after the current row arrives. */}
      <span className="convo-notice__num ui-task-number">#{number}</span>
      <span className="convo-notice__title">{title}</span>
      {owner ? <span className="convo-notice__owner">{owner.kind === 'agent' ? <Kreska size={20} hue={owner.colour} /> : <Avatar name={owner.name} id={owner.id} size="sm" />}<span className="convo-notice__owner-name">{owner.name}</span></span>
        // Nobody owns it: "No owner", the Board's and the panel's word, with the panel's person glyph where the face would be (F-026 §7).
        : row ? <span className="convo-notice__owner convo-notice__owner--none"><Icon name="person" size={16} /><span className="convo-notice__owner-name">No owner</span></span> : null}
      {/* A word always goes with the glyph, at the card's right edge like a decision's (#763 A8). */}
      <span className="convo-object__state convo-notice__state">{reverted ? 'Undone' : STATUS_LABEL[row?.status ?? 'open']}</span>
      <Icon name="chevron-right" size={14} />
    </button>
  );
}

/**
 * In a thread a task made from one of its messages (its root or a reply) is the conversation's task card under that message, its only
 * place in the thread (#1424, design L1059): never a chip inside the bubble with its title cut.
 */
const CardsHere = createContext(false);
export const TaskCardsUnderMessages = CardsHere.Provider;

/** The cards of the tasks made from this message, under it, where a thread draws them (TaskCardsUnderMessages). */
export function MessageTaskCards({ preview }: { preview: MessageWorkPreview | null }) {
  const { openDetails } = useShellActions();
  const cards = useContext(CardsHere);
  // A task whose creation was undone is shown nowhere in the conversation (personas-27 P2 4).
  const tasks = cards ? (preview?.items ?? []).filter((item): item is WorkRowProjection => item.kind === 'work' && item.lifecycle?.state !== 'creation_reverted') : [];
  if (!tasks.length) return null;
  return (
    <div className="msg-tasks">
      {tasks.map((task) => <div key={task.id} className="convo-notice__body convo-notice__card msg-tasks__card" data-work-id={task.id}>
        <TaskObjectRow workId={task.id} number={task.number} title={task.title} row={task} onOpen={() => openDetails({ kind: 'work', id: task.id })} />
      </div>)}
    </div>
  );
}

/**
 * The tasks and decisions this conversation already shows as their own card, by the message they came from (#1424): a task or a
 * decision shows once, so the message they came from carries no chip of them. Keys are `shownKey(messageId, kind, id)`.
 */
const ShownHere = createContext<ReadonlySet<string> | null>(null);
export const ShownObjects = ShownHere.Provider;
export const shownKey = (messageId: string, kind: 'work' | 'decision', id: string) => `${messageId}|${kind}:${id}`;
/** The keys of the cards a conversation draws, from each card's object and its message sources. */
export function shownObjects(cards: Iterable<{ kind: 'work' | 'decision'; id: string; sources: readonly { type: string; id: string }[] }>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const card of cards) for (const source of card.sources) if (source.type === 'message') keys.add(shownKey(source.id, card.kind, card.id));
  return keys;
}

/** Objects made from this message. The message itself is unchanged; these link back to it. */
export function MessageObjects({ message, projectId, preview, thread = null, threadRow = null }: {
  message: ConversationMessage; projectId: string; preview: MessageWorkPreview | null;
  /** The task whose discussion this message opened (UI116-3), and its row from the visible reference read. */
  thread?: { workId: string; title: string; number?: number } | null; threadRow?: NativeWorkRow | null;
}) {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  const navigate = useNavigate();
  const shown = useContext(ShownHere);
  const cards = useContext(CardsHere);
  const counts = preview?.counts ?? { work: 0, decisions: 0 };
  const read = preview?.items ?? [];
  const total = counts.work + counts.decisions;
  const thoughts = preview?.thoughts ?? [];
  // The discussed task, unless the task was also made from this message (then its own chip, or its card, shows it).
  const discussed = thread && !read.some((item) => item.kind === 'work' && item.id === thread.workId) ? thread : null;
  // What the conversation shows as its own card is not repeated here (#1424).
  // A thread draws the tasks as cards under the message (MessageTaskCards), so the bubble carries no chip of them.
  // A task whose creation was undone is shown nowhere (personas-27 P2 4).
  const items = read.filter((item) => !(shown?.has(shownKey(message.id, item.kind, item.id))) && !(cards && item.kind === 'work')
    && !(item.kind === 'work' && item.lifecycle?.state === 'creation_reverted'));
  const more = read.length < total;
  if (!discussed && !items.length && !more && !thoughts.length) return null;
  return (
    <div className="ws-attach">
      {discussed ? <DiscussedTask task={discussed} row={threadRow} /> : null}
      {items.map((item) => <ObjectChip key={`${item.kind}:${item.id}`} objectKind={item.kind} objectId={item.id} icon={item.kind === 'work' ? 'tasks' : 'flag'} number={item.kind === 'work' ? item.number : undefined} state={item.kind === 'work' ? workPieces(item) : decisionPieces(item)} title={item.title} need={item.kind === 'decision' && item.status === 'proposed'} label={item.kind === 'work' ? `Task #${item.number}` : 'Decision'} onOpen={() => openDetails({ kind: item.kind, id: item.id })} />)}
      {/* CW-2: the thought made from this message, as its decisions are; it opens the map with the thought selected. */}
      {thoughts.map((thought) => <ObjectChip key={`thought:${thought.thoughtId}`} objectKind="thought" objectId={thought.thoughtId} icon="map" title={thought.text} state={[{ text: `On the map · ${thought.sketchTitle}` }]} label="On the map"
        onOpen={() => navigate(`/projects/${projectId}/map/${thought.sketchId}#thought-${thought.thoughtId}`)} />)}
      {more ? <button type="button" className="ws-attach__more" onClick={() => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } })}>{[counts.work ? `${counts.work} ${counts.work === 1 ? 'task' : 'tasks'}` : null, counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? 'decision' : 'decisions'}` : null].filter(Boolean).join(' · ')} · view linked objects</button> : null}
    </div>
  );
}

/** A message's Task action opens the one Create window with the message as its source; the notice in the conversation is the server's. */
export function useCreateWorkFromMessage(project: Pick<Project, 'id'>) {
  const { openCreate } = useShellActions();
  /** Opens the Create window prefilled with this message as the task's source (F-026 S3, P5). */
  const create = useCallback((message: ConversationMessage) => {
    const preview = firstLine(messagePreview(message.body, message.files?.length));
    openCreate({ kind: 'task', projectId: project.id, title: firstClause(preview), sources: [{ ref: { type: 'message', id: message.id }, label: preview }] });
  }, [openCreate, project.id]);
  return { create };
}
