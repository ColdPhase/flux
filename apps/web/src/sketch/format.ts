import type { PersonRef, Sketch, Thought } from '@flux/contracts';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function when(iso: string) {
  const date = new Date(iso);
  return new Date().toDateString() === date.toDateString() ? time.format(date) : `${day.format(date)}, ${time.format(date)}`;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export function who(person: PersonRef, meId: string) {
  return person.kind === 'human' && person.id === meId ? 'you' : firstName(person.name);
}

/** "From Kai · 21:14" — quiet provenance under a thought. */
export function provenance(thought: Thought, meId: string) {
  if (thought.version === 0) return 'Added by you · just now';
  return `From ${who(thought.createdBy, meId)} · ${when(thought.createdAt)}`;
}

/** Who can see the sketch, in words: "Only you", "Kai and you", "Everyone in Gesture lamp". */
export function audience(sketch: Sketch, meId: string, projectName?: string | null) {
  if (sketch.scope === 'project') return projectName ? `Everyone in ${projectName}` : 'Everyone in the project';
  const others = sketch.participants.filter((p) => p.id !== meId).map((p) => firstName(p.name));
  if (!others.length) return 'Only you';
  if (others.length === 1) return `${others[0]} and you`;
  return `${others.slice(0, -1).join(', ')}, ${others[others.length - 1]} and you`;
}

export const quote = (text: string) => `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
