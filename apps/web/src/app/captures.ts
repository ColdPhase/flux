import { useCallback, useSyncExternalStore } from 'react';

/**
 * Private quick capture. Until notes exist on the server (#36) a capture is kept only in this
 * browser, per signed-in person, and the interface says so. Nothing is shared or synced.
 */
export interface Capture { id: string; text: string; createdAt: string }

const listeners = new Set<() => void>();
const cache = new Map<string, Capture[]>();
const keyFor = (userId: string) => `flux.captures.${userId}`;

function load(userId: string): Capture[] {
  const cached = cache.get(userId);
  if (cached) return cached;
  let items: Capture[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]');
    if (Array.isArray(parsed)) items = parsed.filter((item): item is Capture => !!item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.createdAt === 'string');
  } catch {
    items = [];
  }
  cache.set(userId, items);
  return items;
}

function save(userId: string, items: Capture[]) {
  cache.set(userId, items);
  try { localStorage.setItem(keyFor(userId), JSON.stringify(items)); } catch { /* storage refused: kept for this visit */ }
  listeners.forEach((listener) => listener());
}

const EMPTY: Capture[] = [];

export function useCaptures(userId: string) {
  const items = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => load(userId),
    () => EMPTY,
  );
  const add = useCallback((text: string) => {
    const capture: Capture = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() };
    save(userId, [...load(userId), capture]);
    return capture;
  }, [userId]);
  const remove = useCallback((id: string) => save(userId, load(userId).filter((item) => item.id !== id)), [userId]);
  return { items, add, remove };
}
