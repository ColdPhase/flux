import type { Decision, ObjectLink, WorkItem, WorkResult, WorkStatus } from '@flux/contracts';

export const STATUS_LABEL: Record<WorkStatus, string> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', not_pursued: 'Not pursued',
};

/** The name a task goes by on every surface (#276): its number in its project, "#12". */
const dueFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
/** A calendar day (`YYYY-MM-DD`) as people read it, with no time zone shift. */
export const dueLabel = (day: string) => dueFormat.format(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
export const taskNumber = (item: { number: number }) => `#${item.number}`;

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export const shortDate = (iso: string) => day.format(new Date(iso));

export function isFinished(item: Pick<WorkItem, 'status'>) {
  return item.status === 'done' || item.status === 'not_pursued';
}

/**
 * A reference card's state as parts that read as the one line (`decisionLine`, `resultLine`, or a work item's
 * status, owner and parking). A part marked `extra` only adds a name or a clause; the narrow one-row card hides it (#665) and keeps
 * the state itself: "In progress", "accepted Oct 23", "Negative result".
 */
export type StatePiece = { text: string; extra?: boolean };
export const stateText = (pieces: StatePiece[]) => pieces.map((piece) => piece.text).join('');

export function workPieces(item: Pick<WorkItem, 'status' | 'owner' | 'parked' | 'lifecycle'>): StatePiece[] {
  if (item.lifecycle?.state === 'creation_reverted') return [{ text: 'creation undone' }];
  return [{ text: STATUS_LABEL[item.status] }, ...(item.owner?.name ? [{ text: ` · ${item.owner.name}`, extra: true }] : []), ...(item.parked ? [{ text: ' · parked' }] : [])];
}

export function decisionPieces(decision: Pick<Decision, 'status' | 'supersedes' | 'decidedAt' | 'supersededAt'>): StatePiece[] {
  if (decision.status === 'proposed') return decision.supersedes ? [{ text: 'Proposed decision' }, { text: ' · would replace an accepted decision', extra: true }] : [{ text: 'Proposed decision' }];
  if (decision.status === 'accepted') return [{ text: 'Decision · ', extra: true }, { text: `accepted ${shortDate(decision.decidedAt!)}` }];
  return [{ text: 'Decision · ', extra: true }, { text: `replaced ${shortDate(decision.supersededAt!)}` }];
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

/** The first line of a message, for prefilled titles. */
export function firstLine(text: string, max = 200) {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A task title made from a message (#763 B5): its first clause, at most `max` characters and cut at a word, so the
 * title names the task and the message stays its quoted source. A clause shorter than 12 characters ("Hi,") reads on.
 */
export function firstClause(text: string, max = 60) {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? '';
  let clause = line;
  for (const stop of line.matchAll(/[.!?;:,\u2013\u2014](?=\s|$)/g)) {
    const head = line.slice(0, stop.index).trim();
    if (head.length >= 12) { clause = head; break; }
  }
  if (clause.length <= max) return clause;
  const cut = clause.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : clause.slice(0, max)).replace(/[\s,;:\u2013\u2014-]+$/, '');
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
