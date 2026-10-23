import { useSyncExternalStore } from 'react';
import type { MapPeer, MapPresenceSource } from '../editing/map-presence';
import { COLLABORATION_INK, assignShapes, type PeerShape } from '../editing/color';
import type { Rect } from './geometry';
import { MAX_LABEL, placeLabels } from './cursor-labels';

/**
 * Without colour, people on the map are told apart by name and a small shape, as in the wiki: the same shape tops the
 * person's cursor, leads their name label and leads their entry in the People chip. It stays with the person while they stay.
 */
const kept = new WeakMap<MapPresenceSource, Map<string, PeerShape>>();
function shapesOf(source: MapPresenceSource, peers: ReadonlyMap<string, MapPeer>): Map<string, PeerShape> {
  const memory = kept.get(source) ?? new Map<string, PeerShape>(); kept.set(source, memory);
  return assignShapes(memory, [...peers.values()].map((peer) => peer.actor.id));
}
const SHOWN_NAMES = 4;

/** The existing People chip updates independently of the sketch geometry/editor. */
export function MapPeople({ source }: { source: MapPresenceSource }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const here = [...new Map([...peers.values()].map((peer) => [peer.actor.id, peer.actor])).values()];
  if (!here.length) return null;
  const shape = shapesOf(source, peers);
  // More than a few people: three names and the count of the rest; every full name stays in the group's label.
  const shown = here.length > SHOWN_NAMES ? here.slice(0, SHOWN_NAMES - 1) : here;
  return <p className="sk-here" role="group" aria-label={`People on this map: ${here.map((person) => person.name).join(', ')}`}>
    {shown.map((person) => <span key={person.id} title={person.name}><i className="editing-shape" data-shape={shape.get(person.id)} aria-hidden="true" /><b>{person.name}</b></span>)}
    {here.length > shown.length ? <span title={here.slice(shown.length).map((person) => person.name).join(', ')}>+{here.length - shown.length}</span> : null}
  </p>;
}

/** Keep the original plane coordinates and constant on-screen cursor size at the current zoom. */
export function MapCursors({ source, origin, zoom, rects, plane }: { source: MapPresenceSource; origin: { x: number; y: number }; zoom: number; rects: ReadonlyMap<string, Rect>; plane: Rect }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const shape = shapesOf(source, peers);
  const drawn = [...peers.entries()].flatMap(([key, peer]) => peer.cursor ? [{ key, peer, cursor: peer.cursor }] : []);
  if (!drawn.length) return null;
  // Every name stays beside its cursor, clear of thoughts, of other names and of other cursors (no DOM reads).
  const labels = placeLabels(drawn.map(({ key, peer, cursor }) => ({ key, name: peer.actor.name, x: cursor.x, y: cursor.y })), rects.values(), zoom, plane);
  return <>{drawn.map(({ key, peer, cursor }) => {
    const at = labels.get(key)!;
    const mark = shape.get(peer.actor.id);
    return <div key={key} className="sk-peer" data-live-peer={peer.actor.name} data-shape={mark} aria-hidden="true"
      style={{ transform: `translate(${cursor.x - origin.x}px, ${cursor.y - origin.y}px) scale(${1 / zoom})`, color: COLLABORATION_INK }}>
      <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1l11 6.5-5 1.4-2.4 5z" fill="currentColor" /></svg>
      <i className="editing-shape sk-peer__mark" data-shape={mark} />
      <span className="sk-peer__label" style={{ ...(at.end ? { right: 14 - (at.dx + at.w) } : { left: at.dx }), top: at.dy, maxWidth: MAX_LABEL }}><i className="editing-shape" data-shape={mark} /><b>{peer.actor.name}</b></span></div>;
  })}</>;
}
