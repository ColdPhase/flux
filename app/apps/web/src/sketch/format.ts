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

/** "From Kai · 21:14" — quiet provenance under a thought: the message it came from, or who added it. */
export function provenance(thought: Thought, meId: string) {
  if (thought.source) {
    const author = thought.source.author.id === meId ? 'you' : firstName(thought.source.author.name);
    return `${thought.source.dmMessageId ? 'Message from' : 'From a message by'} ${author} · ${when(thought.source.sentAt)}`;
  }
  if (thought.version === 0) return 'Added by you · just now';
  return `From ${who(thought.createdBy, meId)} · ${when(thought.createdAt)}`;
}

/**
 * Who can see the sketch, in words: "Only you", "Everyone in Gesture lamp" or, in a direct
 * message, the DM's own audience line ("Only you and Kai").
 */
export function audience(sketch: Sketch, meId: string, projectName?: string | null, dmAudience?: string | null) {
  if (sketch.scope === 'project') return projectName ? `Everyone in ${projectName}` : 'Everyone in the project';
  if (sketch.scope === 'dm') return dmAudience ? `${dmAudience}, in this direct message` : 'The people in this direct message';
  return sketch.createdBy.id === meId ? 'Only you' : `Only ${firstName(sketch.createdBy.name)}`;
}

/** Where a sketch opens: inside its project or DM, so the tabs and audience stay in view. */
export function sketchHref(sketch: Pick<Sketch, 'id' | 'scope' | 'projectId' | 'dmId'>) {
  if (sketch.scope === 'dm' && sketch.dmId) return `/dm/${sketch.dmId}/sketches/${sketch.id}`;
  if (sketch.scope === 'project' && sketch.projectId) return `/projects/${sketch.projectId}/map/${sketch.id}`;
  return `/map/${sketch.id}`;
}

export const quote = (text: string) => `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
