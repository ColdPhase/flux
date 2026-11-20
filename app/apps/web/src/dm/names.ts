import type { DmPerson, DmSummary } from '@flux/contracts';

/** Human names for a DM's audience (#107, design principle 5: every place shows its audience). */
export function othersIn(dm: Pick<DmSummary, 'participants'>, meId: string): DmPerson[] {
  return dm.participants.filter((person) => person.id !== meId);
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The DM's name: a group's title, otherwise the other people ("Kai Tanaka", "Kai, Lee and Mo"). */
export function dmTitle(dm: Pick<DmSummary, 'participants' | 'title' | 'counterpart'>, meId: string): string {
  if (dm.title) return dm.title;
  const others = othersIn(dm, meId);
  // A 1:1 keeps the other person's name after they left; its audience line then says "Only you".
  if (!others.length) return dm.counterpart?.name ?? 'Only you';
  if (others.length === 1) return others[0]!.name;
  if (others.length > 3) return `${others.slice(0, 2).map((p) => firstName(p.name)).join(', ')} and ${others.length - 2} others`;
  return joinNames(others.map((p) => firstName(p.name)));
}

/** What a guest's empty Messages says under "No messages yet" (#1424): they reply in conversations they are added to and start none. */
export const GUEST_NO_DMS = 'When someone writes to you, it appears here.';

/** "Only you and Kai", "Only you, Kai and Lee" from the other people's names; a name not known yet is left out, never an empty "and". */
export function audienceOf(names: string[]): string {
  const first = names.map(firstName).filter(Boolean);
  if (!first.length) return 'Only you';
  return `Only ${joinNames(['you', ...first])}`;
}

/** The audience line shown in the header and composer: "Only you and Kai". */
export function audienceLine(dm: Pick<DmSummary, 'participants'>, meId: string): string {
  return audienceOf(othersIn(dm, meId).map((p) => p.name));
}

/** C-73 (#1591): the header's state while AI is off, "AI off · turned off by Marek" ("by you" for the reader's own); empty while it is on. */
export function aiOffLine(aiOff: readonly DmPerson[], meId: string): string {
  if (!aiOff.length) return '';
  return `AI off · turned off by ${joinNames(aiOff.map((person) => (person.id === meId ? 'you' : firstName(person.name))))}`;
}
