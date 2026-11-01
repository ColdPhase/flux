import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { messagePreview, type ConversationMessage, type NativeWorkRow, type Project } from '@flux/contracts';
import { Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { decisionPieces, firstClause, firstLine, resultPieces, taskNumber, workPieces, type StatePiece } from './format';
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
function ObjectChip({ icon, number, state, title, need, onOpen, label, objectKind, objectId, nativeRef }: { icon: 'tasks' | 'rule' | 'result' | 'map'; number?: number; state: StatePiece[]; title: string; need?: boolean; onOpen: () => void; label: string; objectKind: string; objectId: string; nativeRef?: string }) {
  return (
    <button type="button" data-work-kind={objectKind} data-work-id={objectId} data-native-ref={nativeRef} className={`ws-chip${need ? ' ws-chip--need' : ''}`} onClick={onOpen} aria-label={`${label}: ${title}`}>
      <Icon name={icon} size={14} />
      {number !== undefined ? <span className="ws-chip__num ui-task-number">{taskNumber({ number })}</span> : null}
      <span className="ws-chip__t">{title}</span>
      <span className="ws-chip__k">{state.map((piece, index) => <span key={index} className={piece.extra ? 'ws-chip__x' : undefined}>{piece.text}</span>)}</span>
    </button>
  );
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
  const counts = preview?.counts ?? { work: 0, decisions: 0, results: 0 };
  const items = preview?.items ?? [];
  const total = counts.work + counts.decisions + counts.results;
  const thoughts = preview?.thoughts ?? [];
  // The discussed task, unless the task was also made from this message (then its own chip shows it).
  const discussed = thread && !items.some((item) => item.kind === 'work' && item.id === thread.workId) ? thread : null;
  if (!discussed && !total && !thoughts.length) return null;
  return (
    <div className="ws-attach">
      {discussed ? <DiscussedTask task={discussed} row={threadRow} /> : null}
      {items.map((item) => <ObjectChip key={`${item.kind}:${item.id}`} objectKind={item.kind} objectId={item.id} icon={item.kind === 'work' ? 'tasks' : item.kind === 'decision' ? 'rule' : 'result'} number={item.kind === 'work' ? item.number : undefined} state={item.kind === 'work' ? workPieces(item) : item.kind === 'decision' ? decisionPieces(item) : resultPieces(item)} title={item.title} need={item.kind === 'decision' && item.status === 'proposed'} label={item.kind === 'work' ? `Task #${item.number}` : item.kind === 'decision' ? 'Decision' : 'Result'} onOpen={() => openDetails({ kind: item.kind, id: item.id })} />)}
      {/* CW-2: the thought made from this message, as its decisions are; it opens the map with the thought selected. */}
      {thoughts.map((thought) => <ObjectChip key={`thought:${thought.thoughtId}`} objectKind="thought" objectId={thought.thoughtId} icon="map" title={thought.text} state={[{ text: `On the map · ${thought.sketchTitle}` }]} label="On the map"
        onOpen={() => navigate(`/projects/${projectId}/map/${thought.sketchId}#thought-${thought.thoughtId}`)} />)}
      {items.length < total ? <button type="button" className="ws-attach__more" onClick={() => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } })}>{[counts.work ? `${counts.work} ${counts.work === 1 ? 'task' : 'tasks'}` : null, counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? 'decision' : 'decisions'}` : null, counts.results ? `${counts.results} ${counts.results === 1 ? 'result' : 'results'}` : null].filter(Boolean).join(' · ')} · view linked objects</button> : null}
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
