import type { PersonRef, Sketch, Thought } from '@flux/contracts';
import { named } from '../docs/format';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function when(iso: string) {
  const date = new Date(iso);
  return new Date().toDateString() === date.toDateString() ? time.format(date) : `${day.format(date)}, ${time.format(date)}`;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

/** A person as every view names them: the full name, and "Ada Kowalska (you)" for the reader (design §5 "Naming people"). */
export const who = (person: PersonRef, meId: string) => named(person, meId);

/** "From Kai Berg · 21:14" — quiet provenance under a thought: the message it came from, or who added it. */
export function provenance(thought: Pick<Thought, 'source' | 'version' | 'createdBy' | 'createdAt'>, meId: string) {
  if (thought.source) {
    return `From a message by ${named(thought.source.author, meId)} · ${when(thought.source.sentAt)}`;
  }
  if (thought.version === 0) return `Added by ${who(thought.createdBy, meId)} · just now`;
  return `From ${who(thought.createdBy, meId)} · ${when(thought.createdAt)}`;
}

/** Who can see the map, in words: "Only you" (a private map is always its creator's) or "Everyone in Gesture lamp". */
export function audience(sketch: Sketch, meId: string, projectName?: string | null) {
  if (sketch.scope === 'project') return projectName ? `Everyone in ${projectName}` : 'Everyone in the space';
  return sketch.createdBy.id === meId ? 'Only you' : `Only ${firstName(sketch.createdBy.name)}`;
}

/** Where a map opens: inside its space, so the tabs and audience stay in view. */
export function sketchHref(sketch: Pick<Sketch, 'id' | 'scope' | 'projectId'>) {
  if (sketch.scope === 'project' && sketch.projectId) return `/projects/${sketch.projectId}/map/${sketch.id}`;
  return `/map/${sketch.id}`;
}

export const quote = (text: string) => `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
