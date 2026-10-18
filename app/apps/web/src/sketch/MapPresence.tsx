import { useSyncExternalStore } from 'react';
import type { MapPresenceSource } from '../editing/map-presence';
import { COLLABORATION_INK } from '../editing/color';
import type { Rect } from './geometry';

/** The existing People chip updates independently of the sketch geometry/editor. */
export function MapPeople({ source }: { source: MapPresenceSource }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const here = [...new Map([...peers.values()].map((peer) => [peer.actor.id, peer.actor])).values()];
  return here.length ? <p className="sk-here" role="group" aria-label="People on this map">{here.map((person) => <span key={person.id}><i style={{ background: COLLABORATION_INK }} aria-hidden="true" />{person.name}</span>)}</p> : null;
}

/** Keep the original plane coordinates and constant on-screen cursor size at the current zoom. */
export function MapCursors({ source, origin, zoom, rects }: { source: MapPresenceSource; origin: { x: number; y: number }; zoom: number; rects: ReadonlyMap<string, Rect> }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return [...peers.entries()].flatMap(([key, peer]) => {
    if (!peer.cursor) return [];
    // Check the maximum label box in plane units, without reading or polling the DOM.
    // Its full name remains in the People strip when the nearby label would cover work.
    const label = { x: peer.cursor.x + 12 / zoom, y: peer.cursor.y + 12 / zoom, w: 160 / zoom, h: 20 / zoom };
    let docked = false;
    for (const rect of rects.values()) {
      if (label.x < rect.x + rect.w && label.x + label.w > rect.x && label.y < rect.y + rect.h && label.y + label.h > rect.y) { docked = true; break; }
    }
    return [<div key={key} className="sk-peer" data-live-peer={peer.actor.name} data-name-docked={docked ? 'true' : undefined} aria-hidden="true"
      style={{ transform: `translate(${peer.cursor.x - origin.x}px, ${peer.cursor.y - origin.y}px) scale(${1 / zoom})`, color: COLLABORATION_INK }}>
      <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1l11 6.5-5 1.4-2.4 5z" fill="currentColor" /></svg><span>{peer.actor.name}</span></div>];
  });
}
