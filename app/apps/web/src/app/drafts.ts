import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Unfinished work survives a view switch and a reload (#40): the text in a composer before it
 * is sent, and where the person was reading. Both are kept in this browser per signed-in
 * account and per context (`flux:draft:<userId>:<context>`, `flux:scroll:<userId>:<context>`).
 * When storage is refused the values live in memory for this visit, and the UI says so.
 */
export type DraftStorage = 'device' | 'visit';

interface DraftState { text: string; storage: DraftStorage; revision: number }
interface DraftEntry { state: DraftState; listeners: Set<() => void> }
// One visit-local store for the existing per-account/context browser state. Every edit,
// even A→B→A, advances revision; a failed empty clear is retained as a tombstone.
const memory = new Map<string, DraftEntry>();

function retain(key: string, text: string, storage: DraftStorage, edit = false): DraftEntry {
  const previous = memory.get(key);
  if (previous && !edit && previous.state.text === text && previous.state.storage === storage) return previous;
  const entry = { state: { text, storage, revision: (previous?.state.revision ?? 0) + 1 }, listeners: previous?.listeners ?? new Set<() => void>() };
  memory.set(key, entry);
  return entry;
}

export const draftKey = (userId: string, context: string) => `flux:draft:${userId}:${context}`;
export const scrollKey = (userId: string, context: string) => `flux:scroll:${userId}:${context}`;

function read(key: string): DraftState {
  // A failed write (including an empty clear) is newer than the value still on disk.
  // Keep that override until a successful write; ordinary device writes remain cross-tab readable.
  const previous = memory.get(key);
  if (previous?.state.storage === 'visit') return previous.state;
  try {
    const stored = localStorage.getItem(key);
    return retain(key, stored ?? '', 'device').state;
  } catch { return retain(key, previous?.state.text ?? '', 'visit').state; }
}

/** Writes or removes a value; returns where it now lives. */
function write(key: string, value: string): DraftState {
  let storage: DraftStorage = 'device';
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { storage = 'visit'; }
  const entry = retain(key, value, storage, true);
  for (const listener of entry.listeners) listener();
  return entry.state;
}

/**
 * The pending composer text for one account and context; `clear` is called after Send.
 * A composer for another account or context is a new mount (give it a React `key`).
 */
export function useDraft(userId: string, context: string) {
  const key = draftKey(userId, context);
  const [state, setState] = useState(() => read(key));
  useLayoutEffect(() => {
    const entry = memory.get(key)!;
    const update = () => setState(read(key));
    entry.listeners.add(update);
    update();
    const external = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) update(); };
    window.addEventListener('storage', external);
    return () => { entry.listeners.delete(update); window.removeEventListener('storage', external); };
  }, [key]);
  const setText = useCallback((text: string) => {
    const next = write(key, text);
    setState(next);
    return next.revision;
  }, [key]);
  const clear = useCallback(() => setText(''), [setText]);
  // A command can finish after navigation. Never clear a newer draft from a later mount.
  const clearIfMatches = useCallback((expected: string, revision: number): DraftStorage | null => {
    const current = read(key);
    if (current.text !== expected || current.revision !== revision) return null;
    setText('');
    return read(key).storage;
  }, [key, setText]);
  return { text: state.text, storage: state.storage, revision: state.revision, setText, clear, clearIfMatches };
}

/** Restores, then records, the scroll position of a scroll container for one account and context. */
export function useReadingPosition(ref: RefObject<HTMLElement | null>, userId: string, context: string) {
  const key = scrollKey(userId, context);
  const restored = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || restored.current === key) return;
    restored.current = key;
    const top = Number(read(key).text);
    if (Number.isFinite(top) && top > 0) el.scrollTop = top;
  }, [ref, key]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { write(key, el.scrollTop > 0 ? String(Math.round(el.scrollTop)) : ''); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); el.removeEventListener('scroll', onScroll); };
  }, [ref, key]);
}
