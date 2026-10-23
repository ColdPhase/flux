import { useMemo, useSyncExternalStore } from 'react';
import type { MapPeer, MapPresenceSource } from '../editing/map-presence';
import { COLLABORATION_INK, shapesFor, type PeerShape } from '../editing/color';
import type { Rect } from './geometry';
import { MAX_LABEL, placeLabels } from './cursor-labels';

/**
 * Without colour, people on the map are told apart by name and a small shape, as in the wiki: the same shape tops the
 * person's cursor, leads their name label and leads their entry in the People chip. It stays with the person while they stay.
 */
function shapesOf(peers: ReadonlyMap<string, MapPeer>, selfId: string | undefined): Map<string, PeerShape> {
  return shapesFor([...peers.values()].map((peer) => peer.actor.id).concat(selfId ? [selfId] : []));
}
const SHOWN_NAMES = 4;
/** The spot each label had in this room's last layout, so a label keeps it while it stays clear. */
const spotsOf = new WeakMap<MapPresenceSource, ReadonlyMap<string, string>>();

/** The existing People chip updates independently of the sketch geometry/editor. */
export function MapPeople({ source, selfId }: { source: MapPresenceSource; selfId?: string }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const here = [...new Map([...peers.values()].map((peer) => [peer.actor.id, peer.actor])).values()];
  if (!here.length) return null;
  const shape = shapesOf(peers, selfId);
  // More than a few people: three names and the count of the rest; every full name stays in the group's label.
  const shown = here.length > SHOWN_NAMES ? here.slice(0, SHOWN_NAMES - 1) : here;
  return <p className="sk-here" role="group" aria-label={`People on this map: ${here.map((person) => person.name).join(', ')}`}>
    {shown.map((person) => <span key={person.id} title={person.name}><i className="editing-shape" data-shape={shape.get(person.id)} aria-hidden="true" /><b>{person.name}</b></span>)}
    {here.length > shown.length ? <span title={here.slice(shown.length).map((person) => person.name).join(', ')}>+{here.length - shown.length}</span> : null}
  </p>;
}

/** Keep the original plane coordinates and constant on-screen cursor size at the current zoom. */
export function MapCursors({ source, selfId, origin, zoom, rects, plane }: { source: MapPresenceSource; selfId?: string; origin: { x: number; y: number }; zoom: number; rects: ReadonlyMap<string, Rect>; plane: Rect }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const shape = shapesOf(peers, selfId);
  const drawn = [...peers.entries()].flatMap(([key, peer]) => peer.cursor ? [{ key, peer, cursor: peer.cursor }] : []);
  // A label keeps its spot while it stays clear, and the thoughts' list is rebuilt only when their rectangles change.
  const thoughts = useMemo(() => [...rects.values()], [rects]);
  if (!drawn.length) return null;
  // Every name stays beside its cursor, clear of thoughts, of other names and of other cursors (no DOM reads).
  const labels = placeLabels(drawn.map(({ key, peer, cursor }) => ({ key, name: peer.actor.name, x: cursor.x, y: cursor.y })), thoughts, zoom, plane, spotsOf.get(source));
  spotsOf.set(source, new Map([...labels].map(([key, at]) => [key, at.spot])));
  return <>{drawn.map(({ key, peer, cursor }) => {
    const at = labels.get(key)!;
    const mark = shape.get(peer.actor.id);
    return <div key={key} className="sk-peer" data-live-peer={peer.actor.name} data-shape={mark} aria-hidden="true"
      style={{ transform: `translate(${cursor.x - origin.x}px, ${cursor.y - origin.y}px) scale(${1 / zoom})`, color: COLLABORATION_INK }}>
      <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1l11 6.5-5 1.4-2.4 5z" fill="currentColor" /></svg>
      <i className="editing-shape sk-peer__mark" data-shape={mark} />
      <span className="sk-peer__label" data-spot={at.spot} style={{ ...(at.end ? { right: 14 - (at.dx + at.w) } : { left: at.dx }), top: at.dy, maxWidth: MAX_LABEL }}><i className="editing-shape" data-shape={mark} /><b>{peer.actor.name}</b></span></div>;
  })}</>;
}
