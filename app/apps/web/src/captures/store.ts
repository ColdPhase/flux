import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Notes an account kept only in this browser before private drafts reached the server. No new
 * ones are written (HOME-3, #190): Home offers to move them into the account, one private draft per
 * note, and removes each only after the server confirmed it. Stored per signed-in person, so another
 * account in the same browser is never offered them. Every change re-reads storage first, so a
 * stale tab can never write back a note another tab already moved or deleted.
 */
export interface Capture { id: string; text: string; createdAt: string }

const listeners = new Set<() => void>();
const cache = new Map<string, Capture[]>();
const keyFor = (userId: string) => `flux.captures.${userId}`;
const movingKey = (userId: string) => `flux.captures.moving.${userId}`;
const notify = () => listeners.forEach((listener) => listener());

function read(userId: string): Capture[] {
  let items: Capture[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]');
    if (Array.isArray(parsed)) items = parsed.filter((item): item is Capture => !!item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.createdAt === 'string');
  } catch {
    return cache.get(userId) ?? [];
  }
  cache.set(userId, items);
  return items;
}

function snapshot(userId: string): Capture[] {
  return cache.get(userId) ?? read(userId);
}

/** Removes one note by id, from what storage holds now. */
export function removeCapture(userId: string, id: string) {
  const items = read(userId).filter((item) => item.id !== id);
  cache.set(userId, items);
  try {
    if (items.length) localStorage.setItem(keyFor(userId), JSON.stringify(items));
    else localStorage.removeItem(keyFor(userId));
  } catch { /* storage refused: removed for this visit */ }
  notify();
}

/** Whether the note is still in this browser (another tab may have moved or deleted it). */
export const captureExists = (userId: string, id: string) => read(userId).some((item) => item.id === id);

/**
 * The space a note is being moved into, recorded before its first request, so every retry (from
 * any tab, or after a reload) goes to the same space and its idempotency key matches.
 */
export function moveTarget(userId: string, id: string, chosen: string): string {
  let targets: Record<string, string> = {};
  try { targets = JSON.parse(localStorage.getItem(movingKey(userId)) ?? '{}') as Record<string, string>; } catch { targets = {}; }
  const existing = targets[id];
  if (typeof existing === 'string') return existing;
  try { localStorage.setItem(movingKey(userId), JSON.stringify({ ...targets, [id]: chosen })); } catch { /* kept for this attempt */ }
  return chosen;
}

export function clearMoveTarget(userId: string, id: string) {
  try {
    const targets = JSON.parse(localStorage.getItem(movingKey(userId)) ?? '{}') as Record<string, string>;
    delete targets[id];
    if (Object.keys(targets).length) localStorage.setItem(movingKey(userId), JSON.stringify(targets));
    else localStorage.removeItem(movingKey(userId));
  } catch { /* nothing to clear */ }
}

function hash(text: string, seed: number) {
  // cyrb53: a small deterministic 53-bit hash; enough to tell notes apart in a key, not a secret.
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The note's stable Idempotency-Key: its id, time and text, so a retry is recognised and another note is not. */
export function moveKey(capture: Capture) {
  const content = `${capture.createdAt}\n${capture.text}`;
  return `home-note-v1:${hash(capture.id, 1)}${hash(content, 2)}${hash(content, 3)}`;
}

/** A moved note's draft title: derived from its text the same way every time. */
export const noteTitle = (text: string) => text.slice(0, 80).split('\n')[0] || 'Private note';

const EMPTY: Capture[] = [];

export function useCaptures(userId: string) {
  const items = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot(userId),
    () => EMPTY,
  );
  // Another tab's change arrives as a storage event: read again.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== keyFor(userId)) return;
      read(userId);
      notify();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);
  const remove = useCallback((id: string) => removeCapture(userId, id), [userId]);
  return { items, remove };
}
