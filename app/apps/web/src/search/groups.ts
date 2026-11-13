import type { SearchKind, SearchResult } from '@flux/contracts';

/** The kinds a group lists under one name (a decision stands with the tasks, a map with the thoughts). */
const GROUPS: { label: string; kinds: SearchKind[] }[] = [
  { label: 'Tasks', kinds: ['work', 'decision'] },
  { label: 'Messages', kinds: ['message', 'dm_message'] },
  { label: 'Wiki', kinds: ['doc'] },
  { label: 'Files', kinds: ['file', 'material'] },
  { label: 'Thoughts', kinds: ['thought', 'sketch'] },
  { label: 'Spaces', kinds: ['project'] },
  { label: 'People', kinds: ['person'] },
];

/**
 * The results in groups by kind. The server ranks them (best first), and so do the groups: the one that holds the best match is first, then the
 * one that holds the next best, so a weak match in Tasks never stands above the message that answers the question (#1424). Inside a group the
 * results keep the server's order.
 */
export function groupResults(items: SearchResult[]): { label: string; items: SearchResult[] }[] {
  const groups: { label: string; items: SearchResult[] }[] = [];
  for (const item of items) {
    const label = GROUPS.find((group) => group.kinds.includes(item.kind))?.label;
    if (!label) continue;
    const group = groups.find((other) => other.label === label);
    if (group) group.items.push(item); else groups.push({ label, items: [item] });
  }
  return groups;
}
