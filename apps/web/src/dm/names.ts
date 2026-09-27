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
export function dmTitle(dm: Pick<DmSummary, 'participants' | 'title'>, meId: string): string {
  if (dm.title) return dm.title;
  const others = othersIn(dm, meId);
  if (!others.length) return 'Only you';
  if (others.length === 1) return others[0]!.name;
  if (others.length > 3) return `${others.slice(0, 2).map((p) => firstName(p.name)).join(', ')} and ${others.length - 2} others`;
  return joinNames(others.map((p) => firstName(p.name)));
}

/** The audience line shown in the header and composer: "Only you and Kai". */
export function audienceLine(dm: Pick<DmSummary, 'participants'>, meId: string): string {
  const others = othersIn(dm, meId).map((p) => firstName(p.name));
  if (!others.length) return 'Only you';
  return `Only you and ${joinNames(others)}`;
}
