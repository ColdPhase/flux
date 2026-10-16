import { useCallback, useSyncExternalStore } from 'react';

/**
 * Recent searches (#114): kept only in this browser, per signed-in account, and removed on
 * sign-out. They are the person's own words, never results, so nothing here can outlive access.
 */
const PREFIX = 'flux.search.recent.';
const MAX = 6;
const listeners = new Set<() => void>();
const cache = new Map<string, string[]>();
const EMPTY: string[] = [];

function load(userId: string): string[] {
  const cached = cache.get(userId);
  if (cached) return cached;
  let items: string[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + userId) ?? '[]');
    if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX);
  } catch { items = []; }
  cache.set(userId, items);
  return items;
}

function save(userId: string, items: string[]) {
  cache.set(userId, items);
  try { localStorage.setItem(PREFIX + userId, JSON.stringify(items)); } catch { /* kept for this visit */ }
  listeners.forEach((listener) => listener());
}

export function useRecentSearches(userId: string) {
  const items = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => load(userId),
    () => EMPTY,
  );
  const remember = useCallback((query: string) => {
    const text = query.trim();
    if (!text) return;
    save(userId, [text, ...load(userId).filter((item) => item.toLowerCase() !== text.toLowerCase())].slice(0, MAX));
  }, [userId]);
  const clear = useCallback(() => save(userId, []), [userId]);
  return { items, remember, clear };
}

/**
 * A place the person opened, kept per account on this device for ⌘K's "Recent" (F-026 E02). A place is an identity, not
 * an address: Home, the Sketchbook, the Inbox, one direct message, or one view of one project. Opening it again moves it to
 * the front with the address last seen there, so a project's Wiki is one place whichever page or version was open.
 */
export interface RecentPlace { key: string; path: string }
const PLACE_PREFIX = 'flux.places.recent.';
/** Kept a little longer than shown, so the place in view and places no longer open to the person can be left out. */
const PLACE_MAX = 8;
const placeCache = new Map<string, RecentPlace[]>();
const PLACES_EMPTY: RecentPlace[] = [];

/**
 * The place an address belongs to, or null for what is not a place: search, settings, setup pages, editors, history, live
 * sessions, project settings and unknown addresses (the not-found page). A doc's version folds into the doc.
 */
export function placeOfPath(pathname: string): RecentPlace | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return { key: 'home', path };
  if (path === '/tasks') return { key: 'home:tasks', path };
  if (path === '/docs') return { key: 'home:docs', path };
  if (/^\/map(\/[^/]+)?$/.test(path)) return { key: 'sketchbook', path };
  if (/^\/inbox(\/[^/]+)?$/.test(path)) return { key: 'inbox', path: '/inbox' };
  const dm = /^\/dm\/([^/]+)(?:\/sketches(?:\/[^/]+)?)?$/.exec(path);
  if (dm) return dm[1] === 'new' ? null : { key: `dm:${dm[1]}`, path: `/dm/${dm[1]}` };
  const project = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!project || project[1] === 'new') return null;
  const [, id, rest = ''] = project;
  const base = `/projects/${id}`;
  if (rest === '' || /^\/conversations\/[^/]+$/.test(rest)) return { key: `project:${id}:conversation`, path };
  if (rest === '/tasks') return { key: `project:${id}:tasks`, path };
  if (/^\/map(\/[^/]+)?$/.test(rest)) return { key: `project:${id}:map`, path };
  if (rest === '/agents') return { key: `project:${id}:agents`, path };
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
      items = parsed.filter((item): item is RecentPlace => !!item && typeof item.key === 'string' && typeof item.path === 'string'
        && placeOfPath(item.path)?.key === item.key).slice(0, PLACE_MAX);
    }
  } catch { items = []; }
  placeCache.set(userId, items);
  return items;
}

/** Records the place in view as the most recent one (the same place moves to the front, never twice). */
export function rememberPlace(userId: string, place: RecentPlace) {
  const current = loadPlaces(userId);
  if (current[0]?.key === place.key && current[0].path === place.path) return;
  const next = [place, ...current.filter((item) => item.key !== place.key)].slice(0, PLACE_MAX);
  placeCache.set(userId, next);
  try { localStorage.setItem(PLACE_PREFIX + userId, JSON.stringify(next)); } catch { /* kept for this visit */ }
  listeners.forEach((listener) => listener());
}

export function useRecentPlaces(userId: string): RecentPlace[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => loadPlaces(userId),
    () => PLACES_EMPTY,
  );
}

/** Sign-out: forget every account's recent searches and places in this browser. */
export function forgetRecentSearches() {
  cache.clear();
  placeCache.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX) || key?.startsWith(PLACE_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
  listeners.forEach((listener) => listener());
}
