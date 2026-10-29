import { useEffect, useLayoutEffect, type RefObject } from 'react';
import type { Location, NavigationType } from 'react-router';
import { arrivalEntry, onFlush, recall, remember } from './memory';

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Puts `find()` at `top` as soon as its content is tall enough (a screen's data arrives after the screen shows), holds it
 * there for a moment while the content settles, and stops at once on the reader's scrolling input. It waits `ms` at most
 * for the content. Returns how to stop. Only scrolling input ends it early: a pointer that moves, or focus that lands in
 * the container (a panel focusing itself or its first control as it opens), is not the reader moving the view.
 */
export function restoreTop(find: () => HTMLElement | null, top: number, ms = 3000): () => void {
  const SETTLE_MS = 600;
  let appliedAt = 0;
  let frame = 0;
  let release: () => void = () => undefined;
  let watched: HTMLElement | null = null;
  const started = performance.now();
  let stopped = false;
  const stop = () => { stopped = true; cancelAnimationFrame(frame); release(); };
  const watch = (element: HTMLElement) => {
    release();
    watched = element;
    const key = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key) && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[role="combobox"],[role="listbox"],[contenteditable="true"]'))) stop(); };
    const wheel = (event: WheelEvent) => { if ((event.deltaY || event.deltaX) && !event.ctrlKey) stop(); };
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchmove', stop, { passive: true });
    element.addEventListener('keydown', key);
    release = () => { element.removeEventListener('wheel', wheel); element.removeEventListener('touchmove', stop); element.removeEventListener('keydown', key); };
  };
  const step = () => {
    if (stopped) return;
    const element = find();
    if (element) {
      if (element !== watched) watch(element);
      if (element.scrollHeight - element.clientHeight + 1 >= top) {
        if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
        if (!appliedAt) appliedAt = performance.now();
      }
    }
    if (performance.now() - started > ms || appliedAt && performance.now() - appliedAt > SETTLE_MS) { stop(); return; }
    frame = requestAnimationFrame(step);
  };
  step();
  return stop;
}

/** What the generic page scroller keeps: how far the page was scrolled. */
interface PaneSnap { top: number }

/**
 * A page that scrolls in `.pane-scroll` (Search, the Inbox, a wiki page, a material, and most pages that read) comes back
 * scrolled as it was left. The one tracker listens at the shell's pane, so no page has to know about it.
 */
export function usePaneMemory(paneRef: RefObject<HTMLElement | null>, location: Location, type: NavigationType) {
  // A page with its own reading-position owner (the Tasks board and list) marks its scroller, and keeps it.
  const scroller = (pane: HTMLElement) => pane.querySelector<HTMLElement>(':scope > .pane-scroll:not([data-own-place])');
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const write = () => { const element = scroller(pane); if (element) remember('pane', { top: Math.round(element.scrollTop) } satisfies PaneSnap); };
    const onScroll = (event: Event) => { if (event.target instanceof HTMLElement && event.target === scroller(pane)) write(); };
    pane.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const unflush = onFlush(write);
    return () => { pane.removeEventListener('scroll', onScroll, true); unflush(); };
  }, [paneRef]);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const arrival = arrivalEntry(location, type);
    const kept = arrival ? recall<PaneSnap>('pane', arrival) : undefined;
    if (!pane || !kept || !Number.isFinite(kept.top) || kept.top <= 0) return;
    return restoreTop(() => scroller(pane), kept.top);
    // Once per arrival at an entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
}
