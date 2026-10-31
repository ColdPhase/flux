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

/**
 * What a blocked task waits for, composed the same way on the board, the list and the panel (#763 C1): "Waiting for
 * <person> · <reason>". A reason alone reads as written when it is a sentence ("Needs the gateway first."), and after
 * "Waiting for" when it is the thing waited for ("the sensor delivery"); never "Waiting for Needs …".
 */
export function blockedParts(item: { blocker: string | null; waitingFor?: { name: string } | null }) {
  const reason = item.blocker?.trim() || null;
  const thing = !!reason && /^\p{Ll}/u.test(reason);
  return { person: item.waitingFor?.name ?? null, reason, thing };
}

export function blockedLine(item: { blocker: string | null; waitingFor?: { name: string } | null }) {
  const { person, reason, thing } = blockedParts(item);
  if (person) return reason ? `Waiting for ${person} · ${reason}` : `Waiting for ${person}`;
  return reason && thing ? `Waiting for ${reason}` : reason;
}

/**
 * A task title made from a message (#763 B5): a short first line as written; a long one (over `whole` characters) gives
 * its first clause, at most `max` characters, cut at a word. The message stays the task's quoted source.
 */
export function titleFrom(text: string, max = 60, whole = 80) {
  const line = firstLine(text, 1000);
  // A short message already reads as a task: it is the title as written.
  if (line.length <= whole) return line;
  const end = line.search(/[.!?;:](\s|$)/u);
  const sentence = (end > 0 ? line.slice(0, end) : line).trim();
  const clause = sentence.length <= max ? sentence : sentence.split(/,\s/u, 1)[0]!.trim();
  if (clause.length <= max) return clause.replace(/[.,;:]$/u, '');
  const cut = clause.slice(0, max + 1).replace(/\s+\S*$/u, '');
  return (cut || clause.slice(0, max)).replace(/[.,;:]$/u, '');
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
