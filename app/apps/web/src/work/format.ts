import type { Decision, ObjectLink, WorkItem, WorkResult, WorkStatus } from '@flux/contracts';

export const STATUS_LABEL: Record<WorkStatus, string> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', not_pursued: 'Not pursued',
};

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

export function decisionLine(decision: Pick<Decision, 'status' | 'supersedes' | 'decidedAt' | 'supersededAt'>) {
  if (decision.status === 'proposed') return decision.supersedes ? 'Proposed decision · would replace the current rule' : 'Proposed decision';
  if (decision.status === 'accepted') return `Current rule · accepted ${shortDate(decision.decidedAt!)}`;
  return `Earlier rule · replaced ${shortDate(decision.supersededAt!)}`;
}

export function resultLine(result: Pick<WorkResult, 'finding' | 'createdBy'>) {
  return `${result.finding === 'negative' ? 'Negative' : 'Positive'} result · ${result.createdBy.name}`;
}

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
