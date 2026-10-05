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

/**
 * Where a person was reading: the first item in view (an element with an id, e.g. a note or a
 * draft) and how far below the top it sat, plus the pixel offset when no item is in view. A block
 * that loads above the items later (drafts, offers) then cannot move them out of place.
 */
interface ReadingPlace { top: number; anchor: string | null; offset: number }
const ANCHORS = 'li[id], article[id], [data-anchor]';

function placeOf(el: HTMLElement): ReadingPlace {
  const top = el.getBoundingClientRect().top;
  for (const item of el.querySelectorAll<HTMLElement>(ANCHORS)) {
    const box = item.getBoundingClientRect();
    const anchor = item.id || item.dataset.anchor;
    if (anchor && box.bottom > top + 1) return { top: Math.round(el.scrollTop), anchor, offset: Math.round(box.top - top) };
  }
  return { top: Math.round(el.scrollTop), anchor: null, offset: 0 };
}

function parsePlace(raw: string): ReadingPlace | null {
  if (!raw) return null;
  // Positions saved before anchors were kept are plain pixel offsets.
  if (/^\d+$/.test(raw)) return { top: Number(raw), anchor: null, offset: 0 };
  try {
    const place = JSON.parse(raw) as Partial<ReadingPlace>;
    return typeof place.top === 'number' ? { top: place.top, anchor: typeof place.anchor === 'string' ? place.anchor : null, offset: Number(place.offset) || 0 } : null;
  } catch { return null; }
}

function applyPlace(el: HTMLElement, place: ReadingPlace) {
  const item = place.anchor
    ? el.querySelector<HTMLElement>(`#${CSS.escape(place.anchor)}`) ?? el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(place.anchor)}"]`)
    : null;
  if (item) el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top - place.offset;
  else el.scrollTop = place.top;
}

/** How long a restored place is kept while the page settles, unless the person scrolls first. */
const SETTLE_MS = 3000;

/** Restores, then records, where the person was reading in a scroll container, per account and context. */
export function useReadingPosition(ref: RefObject<HTMLElement | null>, userId: string, context: string) {
  const key = scrollKey(userId, context);
  const restored = useRef<string | null>(null);
  const settling = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || restored.current === key) return;
    restored.current = key;
    settling.current?.();
    const place = parsePlace(read(key));
    if (!place || (place.top <= 0 && !place.anchor)) return;
    applyPlace(el, place);
    // Content that arrives after the restore (drafts, offers, more items) keeps the same item in view,
    // until the person scrolls or the page has settled.
    let frame = 0;
    const again = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => applyPlace(el, place)); };
    const observer = new MutationObserver(again);
    observer.observe(el, { childList: true, subtree: true });
    const stop = () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) el.removeEventListener(name, stop);
      settling.current = null;
    };
    const timer = window.setTimeout(stop, SETTLE_MS);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) el.addEventListener(name, stop, { passive: true });
    settling.current = stop;
  }, [ref, key]);
  useEffect(() => () => settling.current?.(), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const place = placeOf(el);
        write(key, place.top > 0 ? JSON.stringify(place) : '');
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); el.removeEventListener('scroll', onScroll); };
  }, [ref, key]);
}
