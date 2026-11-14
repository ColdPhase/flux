import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

/**
 * A place the person opened, kept per account on this device for Search's "Recent" (F-026 E02). A place is an identity, not
 * an address: Home, the Sketchbook, the Inbox, one direct message, or one space. Opening it again moves it to the front with the
 * address last seen there, so a space is one row whichever of its views (Conversation, Tasks, Map, Wiki) or pages was open (#1424).
 */
export interface RecentPlace {
  /** The view's own key (`project:<id>:tasks`); `placeIdentity` is the place it belongs to. */
  key: string;
  path: string;
  /** The object's own title when the place is one object, e.g. a Wiki page; a view is named by its project and view. */
  title?: string;
}
const PLACE_PREFIX = 'flux.places.recent.';
/** Kept a little longer than shown, so the place in view and places no longer open to the person can be left out. */
const PLACE_MAX = 8;
const placeCache = new Map<string, RecentPlace[]>();
const PLACES_EMPTY: RecentPlace[] = [];

/** What a recent row stands for: the space for any view of it, the key itself for Home, the Inbox or a direct message. */
export const placeIdentity = (key: string) => (key.startsWith('project:') ? key.split(':').slice(0, 2).join(':') : key);

/**
 * The place an address belongs to, or null for what is not a place: settings, setup pages, editors, history, live
 * sessions, project settings and unknown addresses (the not-found page). A doc's version folds into the doc.
 */
export function placeOfPath(pathname: string): RecentPlace | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return { key: 'home', path };
  if (path === '/tasks') return { key: 'home:tasks', path };
  if (/^\/map(\/[^/]+)?$/.test(path)) return { key: 'sketchbook', path };
  if (/^\/inbox(\/[^/]+)?$/.test(path)) return { key: 'inbox', path: '/inbox' };
  const dm = /^\/dm\/([^/]+)$/.exec(path);
  if (dm) return dm[1] === 'new' ? null : { key: `dm:${dm[1]}`, path: `/dm/${dm[1]}` };
  const project = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!project || project[1] === 'new') return null;
  const [, id, rest = ''] = project;
  const base = `/projects/${id}`;
  if (rest === '' || /^\/conversations\/[^/]+$/.test(rest)) return { key: `project:${id}:conversation`, path };
  if (rest === '/tasks') return { key: `project:${id}:tasks`, path };
  if (/^\/map(\/[^/]+)?$/.test(rest)) return { key: `project:${id}:map`, path };
  const doc = /^\/docs(?:\/([^/]+)(\/versions\/\d+)?)?$/.exec(rest);
  if (doc && doc[1] !== 'new') return { key: `project:${id}:docs`, path: doc[1] ? `${base}/docs/${doc[1]}` : `${base}/docs` };
  return null;
}

function loadPlaces(userId: string): RecentPlace[] {
  const cached = placeCache.get(userId);
  if (cached) return cached;
  let items: RecentPlace[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PLACE_PREFIX + userId) ?? '[]');
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((item): item is RecentPlace => !!item && typeof item.key === 'string' && typeof item.path === 'string'
        && placeOfPath(item.path)?.key === item.key && (item.title === undefined || typeof item.title === 'string'));
      // One row per place: an earlier version of this list kept a row for each view of a space, and the newest of them stays.
      items = valid.filter((item, at) => valid.findIndex((other) => placeIdentity(other.key) === placeIdentity(item.key)) === at).slice(0, PLACE_MAX);
    }
  } catch { items = []; }
  placeCache.set(userId, items);
  return items;
}

/** Records the place in view as the most recent one (the same place moves to the front, never twice, whichever of its views it was). */
export function rememberPlace(userId: string, place: RecentPlace) {
  const current = loadPlaces(userId);
  if (current[0]?.key === place.key && current[0].path === place.path && current[0].title === place.title) return;
  const next = [place, ...current.filter((item) => placeIdentity(item.key) !== placeIdentity(place.key))].slice(0, PLACE_MAX);
  placeCache.set(userId, next);
  try { localStorage.setItem(PLACE_PREFIX + userId, JSON.stringify(next)); } catch { /* kept for this visit */ }
  listeners.forEach((listener) => listener());
}

/** The places kept for this account, most recent first (the same list `useRecentPlaces` reads). */
export const recentPlacesOf = loadPlaces;

export function useRecentPlaces(userId: string): RecentPlace[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => loadPlaces(userId),
    () => PLACES_EMPTY,
  );
}

/** Sign-out: forget every account's recent places in this browser. */
export function forgetRecentPlaces() {
  placeCache.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PLACE_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
  listeners.forEach((listener) => listener());
}
