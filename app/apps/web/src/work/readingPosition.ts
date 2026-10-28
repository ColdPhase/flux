import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { lastReaderInput, readerActive, watchReaderInput } from './readerIntent';
import { onFlush, remember } from '../place/memory';

const THAW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** A pointer that moved this recently is aiming at the message under it; a parked one is not. */
const POINTER_AIM_MS = 2000;

/** Where a thread was left (#592): the message in view, its offset, the scroll position, and whether the reader followed the end. */
export interface ThreadPlace { id: string; offset: number; top: number; atEnd: boolean }
export function threadPlace(value: unknown): ThreadPlace | null {
  if (!value || typeof value !== 'object') return null;
  const kept = value as Partial<ThreadPlace>;
  return typeof kept.id === 'string' && kept.id && typeof kept.offset === 'number' && Number.isFinite(kept.offset) && typeof kept.top === 'number' && Number.isFinite(kept.top) && typeof kept.atEnd === 'boolean'
    ? { id: kept.id, offset: kept.offset, top: kept.top, atEnd: kept.atEnd } : null;
}

/**
 * The one reading-position owner of a feed of messages (a project thread, a direct message and its thread). `slot` is where the
 * place is kept under the history entry; `restore` is the place a return starts from (it may be given once the message it names
 * has loaded: the feed's node is held back until then).
 */
export function useMessageReadingPosition(ref: RefObject<HTMLElement | null>, node: HTMLElement | null, ready: boolean, observedAt: string | undefined, restore: ThreadPlace | null = null, slot = 'thread') {
  // A return starts from the place the feed was left: this hook's own restoring then puts the message back at its offset.
  const anchor = useRef<ThreadPlace | null>(restore);
  const readerMoved = useRef(false);
  // The scrollTop this hook last wrote. A scroll event it did not write records the position
  // (wheel, keys, scrollIntoView, focus, find-in-page). A change found before its event arrived
  // is the reader's only after genuine reader input (readerIntent.ts); otherwise it is layout
  // and the reading position is restored.
  const ownScroll = useRef<number | null>(null);
  // A reader at the end follows what arrives there; reaching the end starts following and only
  // scrolling up leaves it. Layout shifts (scroll anchoring, a resized composer) keep the intent.
  const following = useRef(!!restore?.atEnd);
  // A place that is given later (its message had to be read back to first) replaces the one this hook started with.
  useLayoutEffect(() => { anchor.current = restore; following.current = !!restore?.atEnd; }, [restore]);
  // The scrollTop last seen in a scroll event or written here, for the feed element it belongs to.
  const lastTop = useRef(0);
  // When that scrollTop was recorded (performance.now()).
  const lastSeenAt = useRef(Number.NEGATIVE_INFINITY);
  const seen = useRef<HTMLElement | null>(null);
  // The message a mouse or pen points at, where it is on screen and when the pointer last
  // moved. Previews, reference rows and the header's state line arrive later; none of them may
  // move it out from under a pointer that is aiming at it (moved within POINTER_AIM_MS), even
  // at the end.
  const pointed = useRef<{ row: HTMLElement; top: number; at: number; x: number; y: number } | null>(null);
  // Until this time (after a reference was followed) what the layout does is not the reader: the anchor is kept (#592).
  const frozenUntil = useRef(0);
  const save = useCallback((intent = false) => {
    const pane = ref.current;
    if (!pane || !ready && !readerMoved.current && !intent) return;
    if (performance.now() < frozenUntil.current) return;
    const top = pane.getBoundingClientRect().top;
    const message = [...pane.querySelectorAll<HTMLElement>('[data-message-id],[data-answer-run]')].find((row) => row.getBoundingClientRect().bottom > top);
    if (message) {
      anchor.current = { id: message.id, offset: message.getBoundingClientRect().top - top, top: pane.scrollTop, atEnd: following.current || pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 8 };
      remember(slot, anchor.current);
    }
  }, [ref, ready, slot]);
  // The place is written as a reference is followed; what the layout does while the next screen loads (a progress line
  // pushing the feed down, a pointer-aimed message kept under the pointer) is not where the reader was, until they scroll.
  useEffect(() => onFlush(() => { save(); frozenUntil.current = performance.now() + 3000; }), [save]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || pane !== node) return;
    const atEnd = () => pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 8;
    const toEnd = () => { pane.scrollTop = pane.scrollHeight; ownScroll.current = pane.scrollTop; lastTop.current = pane.scrollTop; };
    // Record a position: the reader's (any scroll this hook did not write) or this hook's own.
    const observe = (reader: boolean) => {
      if (reader) readerMoved.current = true;
      if (atEnd()) following.current = true;
      else if (reader && pane.scrollTop < lastTop.current - 1) following.current = false;
      lastTop.current = pane.scrollTop;
      lastSeenAt.current = performance.now();
      save(reader);
    };
    // The reader moved the view: input within READER_INPUT_MS, or input since the position was
    // last recorded (its scroll event may still be on its way).
    const byReader = () => readerActive(pane) || lastReaderInput(pane) > lastSeenAt.current;
    // Keep the pointed message where it is on screen, also when the feed itself moves because
    // something above it grew (scrollTop is clamped, so this is best effort at either end).
    // Returns whether a pointed message decided the position.
    const keepPointed = () => {
      const held = pointed.current;
      if (!held || !held.row.isConnected || !pane.contains(held.row)) { pointed.current = null; return false; }
      if (performance.now() - held.at > POINTER_AIM_MS) return false;
      // A native scroll the reader started (wheel, keys, touch) owns the position until it ends: writing
      // scrollTop now would cancel an animated scroll mid-gesture (WebKit stops short of where the
      // reader was going). Each scroll event re-aims the pointer, so nothing is lost; scrollend settles.
      if (readerMoved.current) return true;
      const delta = held.row.getBoundingClientRect().top - held.top;
      if (Math.abs(delta) > 0.5) { pane.scrollTop += delta; ownScroll.current = pane.scrollTop; lastTop.current = pane.scrollTop; }
      return true;
    };
    const aim = (target: Element | null, x: number, y: number, at: number) => {
      const row = target?.closest<HTMLElement>('[data-message-id],[data-answer-run]') ?? null;
      pointed.current = row && pane.contains(row) ? { row, top: row.getBoundingClientRect().top, at, x, y } : null;
    };
    const point = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      aim(event.target instanceof Element ? event.target : null, event.clientX, event.clientY, performance.now());
    };
    const left = () => { pointed.current = null; };
    // Input away from the end means the reader is with earlier messages: stop following the end,
    // so growth below does not pull what they are reading or pointing at out from under them.
    const release = watchReaderInput(pane, () => { if (!atEnd()) following.current = false; });
    // Scroll events arrive with the next rendered frame. A reader's scroll that has happened but
    // whose event has not arrived yet (input, then scrollIntoView or focus) is still the
    // reader's position: record it instead of restoring an anchor saved before it. The same
    // unrecorded change without reader input is layout, and the reading position is restored.
    const fresh = seen.current !== pane;
    seen.current = pane;
    const own = ownScroll.current;
    const unobserved = !fresh && Math.abs(pane.scrollTop - lastTop.current) > 1 && (own === null || Math.abs(pane.scrollTop - own) > 1) && byReader();
    const stored = anchor.current;
    if (unobserved) { ownScroll.current = null; observe(true); }
    else if (keepPointed()) { /* the pointed message keeps its place */ }
    else if (following.current) { if (!atEnd()) toEnd(); }
    else if (stored && (ready || !readerMoved.current)) {
      const message = [...pane.querySelectorAll<HTMLElement>('[data-message-id],[data-answer-run]')].find((row) => row.id === stored.id);
      const target = stored.atEnd ? pane.scrollHeight - pane.clientHeight
        : message ? pane.scrollTop + message.getBoundingClientRect().top - pane.getBoundingClientRect().top - stored.offset : stored.top;
      // Even a no-op scrollTop assignment interrupts native smooth key/touch scrolling.
      if (Math.abs(target - pane.scrollTop) > 0.5) { pane.scrollTop = target; ownScroll.current = pane.scrollTop; lastTop.current = pane.scrollTop; }
    }
    // Observed reader motion survives intermediate observations in the same native gesture.
    // Pointer/focus input alone must not suspend a settled loading anchor.
    // Do not write scrollTop while it is moving; scrollend returns settled loading
    // transitions to this owner rather than competing browser scroll anchoring.
    if (ready) save();
    const scrolled = () => {
      const own = ownScroll.current;
      ownScroll.current = null;
      // A scroll this hook did not write moved the view (the reader, or the app bringing a
      // message into view): the pointer now aims at whatever message is under it.
      const reader = own === null || Math.abs(pane.scrollTop - own) > 1;
      const held = pointed.current;
      if (reader && held) aim(document.elementFromPoint(held.x, held.y), held.x, held.y, held.at);
      observe(reader);
    };
    const settled = () => { readerMoved.current = false; save(true); };
    const grew = () => { if (keepPointed()) return; if (following.current && !atEnd()) toEnd(); };
    const resize = new ResizeObserver(grew);
    resize.observe(pane);
    if (pane.firstElementChild) resize.observe(pane.firstElementChild);
    // The reader's own input (wheel, touch, scroll keys, a press on the scroll bar, focus moving to something in the feed) makes
    // the position theirs again at once.
    const thaw = () => { frozenUntil.current = 0; };
    const thawKey = (event: KeyboardEvent) => { if (THAW_KEYS.has(event.key) && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[role="combobox"],[role="listbox"],[contenteditable="true"]'))) thaw(); };
    const thawPress = (event: PointerEvent) => { if (event.target === pane) thaw(); };
    const thawFocus = (event: FocusEvent) => { if (event.target !== pane) thaw(); };
    pane.addEventListener('wheel', thaw, { passive: true });
    pane.addEventListener('touchmove', thaw, { passive: true });
    pane.addEventListener('keydown', thawKey);
    pane.addEventListener('pointerdown', thawPress, { passive: true });
    pane.addEventListener('focusin', thawFocus);
    pane.addEventListener('scroll', scrolled, { passive: true });
    pane.addEventListener('scrollend', settled);
    pane.addEventListener('pointermove', point, { passive: true });
    pane.addEventListener('pointerleave', left, { passive: true });
    return () => {
      resize.disconnect();
      pane.removeEventListener('wheel', thaw); pane.removeEventListener('touchmove', thaw);
      pane.removeEventListener('keydown', thawKey); pane.removeEventListener('pointerdown', thawPress); pane.removeEventListener('focusin', thawFocus);
      pane.removeEventListener('scroll', scrolled);
      pane.removeEventListener('scrollend', settled);
      pane.removeEventListener('pointermove', point); pane.removeEventListener('pointerleave', left);
      release();
    };
  }, [ref, node, ready, observedAt, save]);
  return save;
}
