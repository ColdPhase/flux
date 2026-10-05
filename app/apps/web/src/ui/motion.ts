import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { arrivalShouldAnimate, arrivals, cssTimeToMs, loopShouldRun } from './motion-rules';

/**
 * Motion helpers. Durations and easings come from the CSS tokens, which are 0ms under
 * prefers-reduced-motion, so script-driven motion switches off together with CSS motion.
 */
const reduceQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function duration(name: '--dur-1' | '--dur-2' | '--dur-3'): number {
  if (reduceQuery?.matches) return 0;
  return cssTimeToMs(token(name));
}

export type Easing = '--ease-out' | '--ease-in' | '--ease-sheet';

/** Runs a Web Animation and resolves when it ends (or at once when motion is off). */
export function play(el: Element | null, frames: Keyframe[], ms: number, easing: Easing, options: KeyframeAnimationOptions = {}): Promise<Animation | null> {
  if (!el || !ms || typeof el.animate !== 'function') return Promise.resolve(null);
  const animation = el.animate(frames, { duration: ms, easing: token(easing) || 'ease-out', ...options });
  return animation.finished.then(() => animation, () => null);
}

/** Remembers element positions, lets layout change, then animates them from where they were (FLIP). */
export function flip(elements: (Element | null)[], ms = duration('--dur-3')) {
  const items = elements.filter((el): el is Element => !!el).map((el) => ({ el, rect: el.getBoundingClientRect() }));
  return () => {
    if (!ms) return;
    for (const { el, rect } of items) {
      const now = el.getBoundingClientRect();
      const dx = rect.left - now.left;
      const dy = rect.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) >= 1) void play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], ms, '--ease-sheet');
    }
  };
}

/** Whether a modal or an inert ancestor covers this element, so it can be neither seen nor reached. */
export function isObscured(el: Element): boolean {
  if (el.closest('[inert]')) return true;
  for (const modal of document.querySelectorAll('[aria-modal="true"], dialog[open]')) if (!modal.contains(el)) return true;
  return false;
}

/**
 * A callback ref for a looping mark (an active run, a live session; #155 AC-4): its animation pauses
 * (`data-motion-paused`) while the page is hidden, the mark is off screen or a modal covers it.
 */
export function useLoopPause<T extends HTMLElement>(): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  useEffect(() => {
    if (!node) return;
    let intersecting = true;
    let frame = 0;
    const update = () => {
      frame = 0;
      const run = loopShouldRun({ hidden: document.visibilityState === 'hidden', intersecting, obscured: isObscured(node) });
      node.toggleAttribute('data-motion-paused', !run);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const seen = new IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); update(); });
    seen.observe(node);
    const covers = new MutationObserver(schedule);
    covers.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'inert', 'open'] });
    document.addEventListener('visibilitychange', update);
    update();
    return () => { seen.disconnect(); covers.disconnect(); document.removeEventListener('visibilitychange', update); if (frame) cancelAnimationFrame(frame); };
  }, [node]);
  return setNode;
}

/**
 * Gives a feed's genuinely new entries a short arrival (opacity and a 4px rise over --dur-2) when the
 * reader can see them arrive (#155, UI116-5). Restored history, earlier pages and refreshed entries never
 * move. Each arrived element records `data-arrival` ("animated" or "static"); `onArrived` hears the ids.
 * Call it after the feed's own layout effects, so visibility is measured where the reader now is.
 */
export function useArrivals(feed: RefObject<HTMLElement | null>, ids: readonly string[], elementFor: (id: string) => HTMLElement | null, onArrived?: (ids: string[]) => void) {
  const previous = useRef<readonly string[] | null>(null);
  const key = ids.join('\n');
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = key ? key.split('\n') : [];
    const arrived = arrivals(before, previous.current);
    const pane = feed.current;
    if (!arrived.length || !pane) return;
    const ms = duration('--dur-2');
    const box = pane.getBoundingClientRect();
    for (const id of arrived) {
      const el = elementFor(id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const animate = arrivalShouldAnimate({ reduced: !ms, hidden: document.visibilityState === 'hidden', visible: rect.bottom > box.top && rect.top < box.bottom, obscured: isObscured(el) });
      el.dataset.arrival = animate ? 'animated' : 'static';
      if (animate) void play(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], ms, '--ease-out');
    }
    onArrived?.(arrived);
    // Runs on each change of the ids; the element lookup and listener are read when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * One short traveling highlight within a list (#155, UI116-5 project selector). It goes to the first
 * item found for `selectors`, in order (e.g. the item being opened, then the current one), moving from
 * where it was (transform over --dur-2, 0 with reduced motion; its height is set at once). An interrupted move retargets
 * from where it is, so it settles on the latest choice. It never takes focus or moves scroll, and hides
 * while the list is not shown. The list gets `has-glide` while the highlight stands in for the current
 * item's own background.
 */
export function useTravelingHighlight(list: RefObject<HTMLElement | null>, glide: RefObject<HTMLElement | null>, selectors: readonly string[]): (item: HTMLElement) => void {
  const order = selectors.join('\n');
  const placed = useRef({ value: false });
  // The chosen item, from the click itself: the highlight starts moving in the next frame, before the
  // router renders the pending navigation (which can take longer than one frame on a large view).
  // After every render: the chosen or current item may have changed.
  useLayoutEffect(() => { placeHighlight(list.current, glide.current, order, placed.current, true); });
  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const state = placed.current;
    // A resize (the drawer opening, rows wrapping, fonts arriving) places it again without motion.
    const again = () => placeHighlight(list.current, glide.current, order, state, false);
    const observer = new ResizeObserver(again);
    observer.observe(box);
    void document.fonts?.ready.then(again);
    return () => observer.disconnect();
  }, [list, glide, order]);
  return (item) => placeHighlight(list.current, glide.current, order, placed.current, true, item);
}

/** Whether a click on a link opens it here (not a new tab or window, and not already handled). */
export function choosesInPlace(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

/** Moves `mark` over the first item of `box` matching `order` (newline-separated selectors). */
function placeHighlight(box: HTMLElement | null, mark: HTMLElement | null, order: string, placed: { value: boolean }, animate: boolean, chosen?: HTMLElement) {
  if (!box || !mark) return;
  let current: HTMLElement | null = chosen && box.contains(chosen) ? chosen : null;
  if (!current) for (const selector of order.split('\n')) { current = box.querySelector<HTMLElement>(selector); if (current) break; }
  if (!current || !box.offsetParent) {
    mark.style.opacity = '0';
    box.classList.remove('has-glide');
    placed.value = false;
    return;
  }
  const from = box.getBoundingClientRect();
  const to = current.getBoundingClientRect();
  const fresh = !animate || !placed.value;
  if (fresh) mark.style.transition = 'none';
  mark.style.opacity = '1';
  mark.style.transform = `translateY(${Math.round(to.top - from.top)}px)`;
  mark.style.height = `${Math.round(to.height)}px`;
  mark.dataset.target = current.dataset.glideId ?? '';
  box.classList.add('has-glide');
  if (fresh) { void mark.offsetWidth; mark.style.transition = ''; }
  placed.value = true;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Layout breakpoints from direction C. */
export const MEDIA = {
  navDrawer: '(max-width: 680px)',
  panelOverlay: '(max-width: 1000px)',
  phone: '(max-width: 640px)',
  /** Touch-first devices: Enter adds a line in composers and the send button sends (#189). */
  touch: '(hover: none)',
} as const;

/**
 * Whether Enter sends (or saves) in a composer: on a keyboard-first device Enter sends and
 * Shift+Enter adds a line; on a touch device Enter adds a line and the send button sends.
 */
export function sendsOnEnter(event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } }, touch: boolean) {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !touch;
}
