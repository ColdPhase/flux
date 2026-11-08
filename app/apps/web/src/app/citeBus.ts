// A map thought is cited from the map (#469): the composer shows a tile and the sent message carries a cited card. The map is another
// route, so the citation is held for the composer that opens next. (A message is no longer cited from its menu, #867.)
import type { DraftCite } from '../composer/draft';

const ONE_LINE = 120;

/** A map thought as its citation tile names it. */
export function thoughtCite(thought: { id: string; text: string }, place: string): DraftCite {
  const first = thought.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return { kind: 'thought', id: thought.id, title: (first.length > ONE_LINE ? `${first.slice(0, ONE_LINE - 1).trimEnd()}…` : first) || 'Thought', context: place };
}

/** A citation made on another route, waiting for the conversation named by `place` (a project id or `dm:<id>`) to open. */
let held: { place: string; cite: DraftCite } | null = null;
export function holdCite(place: string, citation: DraftCite) { held = { place, cite: citation }; }
/** Takes the held citation when it was made for this place; any other stays held. */
export function takeHeldCite(place: string): DraftCite | null {
  if (!held || held.place !== place) return null;
  const { cite: citation } = held;
  held = null;
  return citation;
}
