import type { Decision, ObjectLink, WorkItem, WorkResult, WorkStatus } from '@flux/contracts';

export const STATUS_LABEL: Record<WorkStatus, string> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', not_pursued: 'Not pursued',
};

/** The name a task goes by on every surface (#276): its number in its project, "#12". */
export const taskNumber = (item: { number: number }) => `#${item.number}`;

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export const shortDate = (iso: string) => day.format(new Date(iso));

export function isFinished(item: Pick<WorkItem, 'status'>) {
  return item.status === 'done' || item.status === 'not_pursued';
}

/** The quiet kind line of a work item: status, owner and parking, never colour alone. */
export function workLine(item: Pick<WorkItem, 'status' | 'owner' | 'parked' | 'lifecycle'>) {
  // A task whose creation was undone (#238) is named as history, never as current work.
  if (item.lifecycle?.state === 'creation_reverted') return 'Work · creation undone';
  return ['Work', STATUS_LABEL[item.status], item.owner?.name, item.parked ? 'parked' : null].filter(Boolean).join(' · ');
}

/**
 * A reference card's state as parts that read as the one line (`decisionLine`, `resultLine`, `workLine` without its
 * "Work" lead). A part marked `extra` only adds a name or a clause; the narrow one-row card hides it (#665) and keeps
 * the state itself: "In progress", "accepted Oct 23", "Negative result".
 */
export type StatePiece = { text: string; extra?: boolean };
export const stateText = (pieces: StatePiece[]) => pieces.map((piece) => piece.text).join('');

export function workPieces(item: Pick<WorkItem, 'status' | 'owner' | 'parked' | 'lifecycle'>): StatePiece[] {
  if (item.lifecycle?.state === 'creation_reverted') return [{ text: 'creation undone' }];
  return [{ text: STATUS_LABEL[item.status] }, ...(item.owner?.name ? [{ text: ` · ${item.owner.name}`, extra: true }] : []), ...(item.parked ? [{ text: ' · parked' }] : [])];
}

export function decisionPieces(decision: Pick<Decision, 'status' | 'supersedes' | 'decidedAt' | 'supersededAt'>): StatePiece[] {
  if (decision.status === 'proposed') return decision.supersedes ? [{ text: 'Proposed decision' }, { text: ' · would replace the current rule', extra: true }] : [{ text: 'Proposed decision' }];
  if (decision.status === 'accepted') return [{ text: 'Current rule · ', extra: true }, { text: `accepted ${shortDate(decision.decidedAt!)}` }];
  return [{ text: 'Earlier rule · ', extra: true }, { text: `replaced ${shortDate(decision.supersededAt!)}` }];
}

export function resultPieces(result: Pick<WorkResult, 'finding' | 'createdBy'>): StatePiece[] {
  return [{ text: `${result.finding === 'negative' ? 'Negative' : 'Positive'} result` }, { text: ` · ${result.createdBy.name}`, extra: true }];
}

export const decisionLine = (decision: Pick<Decision, 'status' | 'supersedes' | 'decidedAt' | 'supersededAt'>) => stateText(decisionPieces(decision));

export const resultLine = (result: Pick<WorkResult, 'finding' | 'createdBy'>) => stateText(resultPieces(result));

/** The first line of a message, for prefilled titles. */
export function firstLine(text: string, max = 200) {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Links of `id` whose other end is of `type`, with the other end's id and title. */
export function linked(links: ObjectLink[], id: string, type: string, roles?: ObjectLink['role'][]) {
  return links.flatMap((link) => {
    if (roles && !roles.includes(link.role)) return [];
    if (link.from.id === id && link.to.type === type) return [{ id: link.to.id, title: link.toTitle, link }];
    if (link.to.id === id && link.from.type === type) return [{ id: link.from.id, title: link.fromTitle, link }];
    return [];
  });
}

/** Objects created from or based on a message. */
export function fromMessage<T extends { id: string; links: ObjectLink[] }>(items: T[], messageId: string) {
  return items.filter((item) => item.links.some((link) => link.from.id === item.id && link.role === 'source' && link.to.type === 'message' && link.to.id === messageId));
}
