import { removedName, type NamedPrincipal } from '@flux/contracts';
import { named, youLabel } from './youLabel';

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const shortDate = (iso: string) => day.format(new Date(iso));
export const longDate = (iso: string) => stamp.format(new Date(iso));
/** "just now", "5 min ago", "2 h ago", "3 d ago", then the date: how recently a page changed. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} d ago`;
  return shortDate(iso);
}

/**
 * One source of truth for naming an agent author (#200): the marker after its name, exactly as
 * rendered everywhere an agent writes under its owner's standing grant (#152); shared by the
 * combined label below and by views that style the name and the marker separately.
 */
export const AGENT_SUFFIX = ' · agent';
/** An agent's display name, or "Agent" once its connection has none yet. */
export const agentDisplayName = (agent: { name?: string }) => agent.name ?? 'Agent';
/** How a reader names an agent: "<name> · agent", as in the conversation. A missing name shows "Agent". */
export const agentAuthorLabel = (agent: { name?: string }) => `${agentDisplayName(agent)}${AGENT_SUFFIX}`;
/**
 * Someone who wrote here and is no longer someone the reader's lists name, and who was not removed from the company (#763 XC-2): named the same
 * way everywhere, never the bare role "Member". A person who left the company or was removed is "Stefan Kowal (removed)" instead (founder
 * decision, Hubert, 2026-11-17, #1424; `removedName`).
 */
export const FORMER_MEMBER = 'Former member';
/**
 * The one name of a person who wrote in a space, for every reader and every surface: the stream, a thread, a task's discussion and its
 * call lines (persona round 6 P2 4). The reader themself; then the company's members (a member's read of them); then the space's people,
 * which is all a guest can read (the company's list is not theirs, so it is empty for them); then the name the server gives a message whose
 * author left the company or was removed, "Stefan Kowal (removed)" (`removed`, #1424); else "Former member".
 */
export function personName(userId: string, me: { id: string; name: string }, members: readonly { userId: string; name: string }[],
  people: readonly { kind: string; id: string; name: string }[] | null, removed?: string): string {
  if (userId === me.id) return me.name;
  return members.find((member) => member.userId === userId)?.name
    ?? people?.find((person) => person.kind === 'human' && person.id === userId)?.name ?? (removed ? removedName(removed) : FORMER_MEMBER);
}
/** The reader is "Ada Kowalska (you)" (design §5 "Naming people"): one rule, kept in `./youLabel`. */
export { named, youLabel };
/**
 * Who made a version: the reader is "Ada Kowalska (you)" as everywhere a person is named (personas-36); an agent writing under its owner's
 * standing grant (#152) is named "name · agent", as in the conversation.
 */
export const authorLabel = (who: NamedPrincipal, meId: string) => (who.kind === 'agent' ? agentAuthorLabel(who) : named(who, meId));

const KIND: Record<string, string> = {
  doc: 'Wiki page', work: 'Task', decision: 'Decision', message: 'Message', thought: 'Thought', sketch: 'Map', material: 'Wiki page',
};
export const kindLabel = (type: string) => KIND[type] ?? type;
