/**
 * Where a person left a map (#1553, C-67): its zoom, the plane point at the top left of what they saw, and the thoughts they had selected.
 * Kept per person, map and device in the browser's storage: a convenience that never leaves the device, so it may be missing or refused
 * and the map then opens framed, as it does the first time.
 */
export interface MapView {
  zoom: number;
  /** The plane's own coordinates (stored thought units), so a later change of the plane's edge cannot move the view. */
  x: number;
  y: number;
  selection: string[];
}

const KEY = 'flux.map.view.v1';
const key = (userId: string, sketchId: string) => `${KEY}:${userId}:${sketchId}`;

export function readMapView(userId: string, sketchId: string): MapView | null {
  try {
    const raw = localStorage.getItem(key(userId, sketchId));
    if (!raw) return null;
    const view = JSON.parse(raw) as Partial<MapView> | null;
    if (!view || !Number.isFinite(view.zoom) || !Number.isFinite(view.x) || !Number.isFinite(view.y)) return null;
    const selection = Array.isArray(view.selection) ? view.selection.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
    return { zoom: view.zoom!, x: view.x!, y: view.y!, selection };
  } catch { return null; }
}

export function writeMapView(userId: string, sketchId: string, view: MapView) {
  try { localStorage.setItem(key(userId, sketchId), JSON.stringify(view)); } catch { /* storage may be unavailable: the map opens framed next time */ }
}
