import type { CoWorkRequestKind, CoWorkSourceRef, TaskCoordinationRequest, TaskCoordinationVerdict } from '@flux/contracts';

/** The words of a request card (#400 AC-4): kind, state and verdict in plain English, from the stored record alone. */
export const KIND_WORDS: Record<CoWorkRequestKind, string> = { help: 'Help', review: 'Review', fix: 'Fix', handoff: 'Handoff' };

const DEFER_REASON: Record<string, string> = {
  busy: 'busy', dependency: 'waiting for something else', offline: 'offline', capability: 'can’t yet', policy: 'policy',
};
const DEFER_BOUNDARY: Record<string, string> = {
  after_step: 'after its current step', after_tests: 'after its tests', after_release: 'after it lets go of its task',
  on_dependency: 'once what it waits for is ready', on_resume: 'when it resumes', on_capability: 'when it can',
};
const DECLINE_REASON: Record<string, string> = {
  capability: 'it can’t do this', policy: 'policy doesn’t allow it', scope: 'it is outside its scope', source_changed: 'what it was asked about changed',
};

/** What a request is doing now, in one phrase. Never claims more than the record: queued is not "working". */
export function statusWords(card: Pick<TaskCoordinationRequest, 'status' | 'reason' | 'nextBoundary' | 'cancelledBy' | 'recipient'>): string {
  switch (card.status) {
    case 'queued': return 'Waiting for its next step';
    case 'deferred': {
      const boundary = card.nextBoundary ? DEFER_BOUNDARY[card.nextBoundary] : null;
      const reason = card.reason ? DEFER_REASON[card.reason] : null;
      return `Put off${boundary ? ` until ${boundary}` : ''}${reason ? ` (${reason})` : ''}`;
    }
    case 'working': return 'Being handled';
    case 'offline': return `Waiting: ${card.recipient.name} is offline`;
    case 'cancelled': return card.cancelledBy ? `Cancelled by ${card.cancelledBy.name}` : 'Cancelled';
    case 'resolved': return 'Answered';
    case 'declined': return `Declined${card.reason && DECLINE_REASON[card.reason] ? `: ${DECLINE_REASON[card.reason]}` : ''}`;
    case 'superseded': return 'Replaced by a newer request';
    case 'expired': return 'Expired without an answer';
  }
}

/** A review's outcome, and whether it still applies to what was reviewed. */
export function verdictWords(verdict: Pick<TaskCoordinationVerdict, 'verdict' | 'current'>): string {
  const outcome = verdict.verdict === 'passed' ? 'Passed' : 'Changes requested';
  return verdict.current ? `${outcome} · applies to the current version` : `${outcome} · what it reviewed has changed since, so it no longer applies`;
}

/** The target in a few words: its title while it still exists at that version, else what kind of record it was. */
export function targetWords(card: Pick<TaskCoordinationRequest, 'target' | 'targetTitle' | 'targetAvailable'>): string {
  const ref: CoWorkSourceRef = card.target;
  if (ref.type === 'github_pr') return `Pull request at ${ref.headSha.slice(0, 7)}`;
  const kind = { work: 'Task', material: 'Material', doc: 'Doc', result: 'Result', message: 'Message', thought: 'Thought' }[ref.type];
  const version = 'version' in ref ? ` · version ${ref.version}` : '';
  if (!card.targetAvailable || !card.targetTitle) return `${kind}${version} (changed since)`;
  return `${ref.type === 'work' ? '' : `${kind} `}${ref.type === 'message' ? `“${card.targetTitle}”` : card.targetTitle}${ref.type === 'work' ? version : ''}`.trim();
}

/** Open requests first, then the most recent closed ones; the rest wait behind "Show earlier requests". */
export const CLOSED_SHOWN = 3;
export function splitCards(cards: readonly TaskCoordinationRequest[]) {
  const open = cards.filter((card) => ['queued', 'deferred', 'working', 'offline'].includes(card.status));
  const closed = cards.filter((card) => !open.includes(card));
  return { open, closed: closed.slice(0, CLOSED_SHOWN), earlier: closed.slice(CLOSED_SHOWN) };
}
