import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import { forgetReloadRetention, setReloadRetention } from './reload-retention';

/**
 * Unfinished work survives a view switch and a reload (#40): the text in a composer before it
 * is sent, and where the person was reading. Both are kept in this browser per signed-in
 * account and per context (`flux:draft:<userId>:<context>`, `flux:scroll:<userId>:<context>`).
 * When storage is refused the values live in memory for this visit, and the UI says so.
 */
export type DraftStorage = 'device' | 'visit';

interface DraftState { text: string; storage: DraftStorage; revision: number }
interface DraftEntry { state: DraftState; listeners: Set<() => void>; local: boolean }
// One visit-local store for the existing per-account/context browser state. Every edit,
// even A→B→A, advances revision; a failed empty clear is retained as a tombstone.
// `local`: this tab has edited the value. Its own text then stays what this tab shows; another
// tab's write only advances the fence (two tabs typing at once each keep their own draft, #211).
const memory = new Map<string, DraftEntry>();
let draftGeneration = 0;
let retiredStorage = false;

function retain(key: string, text: string, storage: DraftStorage, edit = false, local = false): DraftEntry {
  const previous = memory.get(key);
  if (previous && !edit && previous.state.text === text && previous.state.storage === storage) return previous;
  const entry = { state: { text, storage, revision: (previous?.state.revision ?? 0) + 1 }, listeners: previous?.listeners ?? new Set<() => void>(), local: local || !!previous?.local };
  memory.set(key, entry);
  if (key.startsWith('flux:draft:')) setReloadRetention('draft', key, key.split(':')[2]!,
    storage === 'visit' && (entry.local || !!text), edit);
  return entry;
}

/** Existing confirmed sign-out retires this visit's private overrides, including failed clears. */
export function forgetBrowserDrafts() {
  draftGeneration++;
  retiredStorage = true;
  const notify = [...memory.values()].flatMap((entry) => [...entry.listeners]);
  memory.clear();
  forgetReloadRetention('draft');
  queueMicrotask(() => notify.forEach((listener) => listener()));
}

export const draftKey = (userId: string, context: string) => `flux:draft:${userId}:${context}`;
export const scrollKey = (userId: string, context: string) => `flux:scroll:${userId}:${context}`;

function read(key: string): DraftState {
  // A failed write (including an empty clear) is newer than the value still on disk.
  // Keep that override until a successful write; a value this tab has not edited stays
  // cross-tab readable, and one it has edited is this tab's own.
  const previous = memory.get(key);
  if (previous?.state.storage === 'visit' || previous?.local) return previous.state;
  try {
    const stored = retiredStorage ? null : localStorage.getItem(key);
    return retain(key, stored ?? '', 'device').state;
  } catch { return retain(key, previous?.state.text ?? '', 'visit').state; }
}

/** Writes or removes a value; returns where it now lives. */
function write(key: string, value: string): DraftState {
  let storage: DraftStorage = 'device';
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { storage = 'visit'; }
  const entry = retain(key, value, storage, true, true);
  for (const listener of entry.listeners) listener();
  return entry.state;
}

// A relevant external edit advances the fence even if queued B→A events both read final A.
// Observe retained keys while their composer is unmounted, because an earlier command may
// still complete. This store holds only private browser drafts/reading positions, not policy.
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  try { if (event.storageArea !== localStorage) return; } catch { /* Conservatively fence a known key. */ }
  const keys = event.key === null ? [...memory.keys()] : memory.has(event.key) ? [event.key] : [];
  for (const key of keys) {
    const current = read(key);
    const entry = retain(key, current.text, current.storage, true);
    for (const listener of entry.listeners) listener();
  }
});

/**
 * The pending composer text for one account and context; `clear` is called after Send.
 * Account/context changes select the current snapshot immediately. A composer with additional
 * command state must still remount with a React `key` so its busy/error/pending work cannot cross.
 */
export function useDraft(userId: string, context: string) {
  const key = draftKey(userId, context);
  const generation = useMemo(() => draftGeneration, [key]);
  const subscribe = useCallback((listener: () => void) => {
    read(key);
    const entry = memory.get(key)!;
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [key]);
  const getSnapshot = useCallback(() => read(key), [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setText = useCallback((text: string) => {
    if (generation !== draftGeneration) return -1;
    const next = write(key, text);
    return next.revision;
  }, [key, generation]);
  const clear = useCallback(() => setText(''), [setText]);
  // A command can finish after navigation. Never clear a newer draft from a later mount.
  const clearIfMatches = useCallback((expected: string, revision: number): DraftStorage | null => {
    if (generation !== draftGeneration) return null;
    const current = read(key);
    if (current.text !== expected || current.revision !== revision) return null;
    setText('');
    return read(key).storage;
  }, [key, setText, generation]);
  return { text: state.text, storage: state.storage, revision: state.revision, setText, clear, clearIfMatches };
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
    const place = parsePlace(read(key).text);
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
