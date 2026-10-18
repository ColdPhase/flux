import { useSyncExternalStore } from 'react';
import type { MapPresenceSource } from '../editing/map-presence';
import { personColor } from '../editing/color';

/** The existing People chip updates independently of the sketch geometry/editor. */
export function MapPeople({ source }: { source: MapPresenceSource }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const here = [...new Map([...peers.values()].map((peer) => [peer.actor.id, peer.actor])).values()];
  return here.length ? <p className="sk-here" role="group" aria-label="People on this map">{here.map((person) => <span key={person.id}><i style={{ background: personColor(person.id) }} aria-hidden="true" />{person.name}</span>)}</p> : null;
}

/** Keep the original plane coordinates and constant on-screen cursor size at the current zoom. */
export function MapCursors({ source, origin, zoom }: { source: MapPresenceSource; origin: { x: number; y: number }; zoom: number }) {
  const peers = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return [...peers.entries()].flatMap(([key, peer]) => peer.cursor ? [<div key={key} className="sk-peer" data-live-peer={peer.actor.name} aria-hidden="true"
    style={{ transform: `translate(${peer.cursor.x - origin.x}px, ${peer.cursor.y - origin.y}px) scale(${1 / zoom})`, color: personColor(peer.actor.id) }}>
    <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1l11 6.5-5 1.4-2.4 5z" fill="currentColor" /></svg><span style={{ background: personColor(peer.actor.id) }}>{peer.actor.name}</span></div>] : []);
}
