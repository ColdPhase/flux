import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Unfinished work survives a view switch and a reload (#40): the text in a composer before it
 * is sent, and where the person was reading. Both are kept in this browser per signed-in
 * account and per context (`flux:draft:<userId>:<context>`, `flux:scroll:<userId>:<context>`).
 * When storage is refused the values live in memory for this visit, and the UI says so.
 */
export type DraftStorage = 'device' | 'visit';

const memory = new Map<string, string>();

export const draftKey = (userId: string, context: string) => `flux:draft:${userId}:${context}`;
export const scrollKey = (userId: string, context: string) => `flux:scroll:${userId}:${context}`;

function read(key: string): string {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored;
  } catch { /* storage refused: fall back to memory */ }
  return memory.get(key) ?? '';
}

/** Writes or removes a value; returns where it now lives. */
function write(key: string, value: string): DraftStorage {
  if (value) memory.set(key, value); else memory.delete(key);
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
    return 'device';
  } catch {
    return 'visit';
  }
}

/**
 * The pending composer text for one account and context; `clear` is called after Send.
 * A composer for another account or context is a new mount (give it a React `key`).
 */
export function useDraft(userId: string, context: string) {
  const key = draftKey(userId, context);
  const [state, setState] = useState(() => ({ text: read(key), storage: 'device' as DraftStorage }));
  const setText = useCallback((text: string) => setState({ text, storage: write(key, text) }), [key]);
  const clear = useCallback(() => setText(''), [setText]);
  return { text: state.text, storage: state.storage, setText, clear };
}

/** Restores, then records, the scroll position of a scroll container for one account and context. */
export function useReadingPosition(ref: RefObject<HTMLElement | null>, userId: string, context: string) {
  const key = scrollKey(userId, context);
  const restored = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || restored.current === key) return;
    restored.current = key;
    const top = Number(read(key));
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
