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

/** Sign-out: forget every account's recent searches in this browser. */
export function forgetRecentSearches() {
  cache.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
  listeners.forEach((listener) => listener());
}
