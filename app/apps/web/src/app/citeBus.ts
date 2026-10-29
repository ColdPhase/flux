// "Cite" on a message cites it in the composer of the same pane (F-026 S6, #469): the composer shows a tile and the sent message
// carries a cited-message card. The stream and the open thread are two composers on one route, so the message's pane names which
// one answers. A map thought is cited from the map, which is another route: it is held for the composer that opens next.
import type { DraftCite } from '../composer/draft';

export type CitePane = 'stream' | 'thread';
type Listener = (cite: DraftCite) => void;
const listeners = new Map<CitePane, Set<Listener>>();

const ONE_LINE = 120;
/** A message as its citation tile names it: the words of its first line, and who wrote it. */
export function messageCite(message: { id: string; body: string; files?: readonly unknown[] }, author: string): DraftCite {
  const first = message.body.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const title = first.length > ONE_LINE ? `${first.slice(0, ONE_LINE - 1).trimEnd()}…` : first;
  return { kind: 'message', id: message.id, title: title || (message.files?.length ? 'Attached files' : 'Message'), context: author };
}

/** A map thought as its citation tile names it. */
export function thoughtCite(thought: { id: string; text: string }, place: string): DraftCite {
  const first = thought.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return { kind: 'thought', id: thought.id, title: (first.length > ONE_LINE ? `${first.slice(0, ONE_LINE - 1).trimEnd()}…` : first) || 'Thought', context: place };
}

export function cite(pane: CitePane, citation: DraftCite) { listeners.get(pane)?.forEach((listener) => listener(citation)); }

export function onCite(pane: CitePane, listener: Listener): () => void {
  const set = listeners.get(pane) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(pane, set);
  return () => { set.delete(listener); };
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
