import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { arrivalShouldAnimate, arrivals, cssTimeToMs, loopShouldRun } from './motion-rules.js';
import { prefersReducedMotion } from './motion-preference.js';

/**
 * Motion helpers. Durations and easings come from the CSS tokens, which are 0ms under
 * prefers-reduced-motion (or the person's own choice, motion-preference.ts), so script-driven motion
 * switches off together with CSS motion.
 */

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export type DurationToken = '--dur-1' | '--dur-2' | '--dur-3' | '--dur-4' | '--dur-in' | '--dur-out' | '--dur-view' | '--dur-press';

export function duration(name: DurationToken): number {
  if (prefersReducedMotion()) return 0;
  return cssTimeToMs(token(name));
}

export type Easing = '--ease-out' | '--ease-in' | '--ease-sheet' | '--ease-spring';

// Nothing moves while the first screen is put up (#593 AC-6): the shell marks motion ready once it has
// committed and painted. A page that is hidden does not move either; what it was showing is its end state.
let ready = false;
export function markMotionReady() { ready = true; }
/** Whether script-driven motion may run now: after first paint, with the page visible. */
export function motionAllowed(): boolean {
  return ready && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
}

/** Every animation the helpers below start carries this id, so they can be told from the page's own CSS. */
export const MOTION_ID = 'flux-motion';
const ours = (animation: Animation) => animation.id === MOTION_ID;
/** Ends the helpers' own animations on an element and its descendants (an exit never lingers into a new state). */
export function cancelMotion(el: Element | null, subtree = false) {
  el?.getAnimations({ subtree }).filter(ours).forEach((animation) => animation.cancel());
}

/** Runs a Web Animation and resolves when it ends (or at once when motion is off). */
export function play(el: Element | null, frames: Keyframe[], ms: number, easing: Easing, options: KeyframeAnimationOptions = {}): Promise<Animation | null> {
  if (!el || !ms || !motionAllowed() || typeof el.animate !== 'function') return Promise.resolve(null);
  const animation = el.animate(frames, { duration: ms, easing: token(easing) || 'ease-out', ...options });
  animation.id = MOTION_ID;
  return animation.finished.then(() => animation, () => null);
}

/** The opacity and transform an element shows now (a running animation included). */
export interface Pose { opacity?: number | string; transform?: string }

function poseNow(el: Element, keys: (keyof Pose)[]): Pose {
  const style = getComputedStyle(el);
  const pose: Pose = {};
  if (keys.includes('opacity')) pose.opacity = style.opacity;
  if (keys.includes('transform')) pose.transform = style.transform === 'none' ? 'none' : style.transform;
  return pose;
}

/**
 * Moves an element to `to` from where it is now (#593 AC-1): an animation of ours that is still running (a
 * panel closed while it opened, reopened while it left) continues from its current opacity and transform
 * instead of snapping to a start or end pose, so the surface always settles on the latest state. Without a
 * running one it starts from `from`. With motion off it cancels ours and leaves the end state at once.
 */
export function settle(el: Element | null, to: Pose, ms: number, easing: Easing, options: { from?: Pose; fill?: FillMode } = {}): Promise<Animation | null> {
  if (!el) return Promise.resolve(null);
  const keys = (['opacity', 'transform'] as const).filter((key) => to[key] !== undefined || options.from?.[key] !== undefined);
  const running = el.getAnimations().some(ours);
  const now = poseNow(el, [...keys]);
  cancelMotion(el);
  if (!ms || !motionAllowed() || typeof el.animate !== 'function') return Promise.resolve(null);
  const from = running ? now : { ...now, ...options.from };
  const animation = el.animate([from as Keyframe, to as Keyframe], { duration: ms, easing: token(easing) || 'ease-out', fill: options.fill ?? 'none' });
  animation.id = MOTION_ID;
  return animation.finished.then(() => animation, () => null);
}

/**
 * Which way the person is travelling (#593 AC-2, AC-3): `back` after Back or the browser's history, otherwise
 * `forward`. Surfaces that slide in the direction of travel read it; the router and the panel set it.
 */
export type TravelDirection = 'forward' | 'back';
let travel: TravelDirection = 'forward';
export const travelDirection = (): TravelDirection => travel;
export function setTravelDirection(direction: TravelDirection) { travel = direction; }

/** Remembers element positions, lets layout change, then animates them from where they were (FLIP). */
export function flip(elements: (Element | null)[], ms = duration('--dur-in')) {
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
    return () => {
      seen.disconnect(); covers.disconnect(); document.removeEventListener('visibilitychange', update); if (frame) cancelAnimationFrame(frame);
      // A mark that stops moving (Kreska's expression changes) must not keep a stale pause.
      node.removeAttribute('data-motion-paused');
    };
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
    // A reader at the end follows it (#170's position owner may scroll after this runs): entries that
    // only extend the feed below that reader arrive where they are looking (#266). Arrivals are always
    // the newest entries, so what they add runs from the bottom of the entry that ended the feed before
    // them to the bottom of the last one, the space between entries included.
    const current = previous.current;
    const lastSeen = current[current.length - arrived.length - 1];
    const end = lastSeen ? elementFor(lastSeen)?.getBoundingClientRect().bottom : undefined;
    const added = end === undefined
      ? arrived.reduce((sum, id) => sum + (elementFor(id)?.getBoundingClientRect().height ?? 0), 0)
      : Math.max(0, ...arrived.map((id) => (elementFor(id)?.getBoundingClientRect().bottom ?? end) - end));
    const following = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= added + 8;
    for (const id of arrived) {
      const el = elementFor(id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const animate = arrivalShouldAnimate({ reduced: !ms, hidden: document.visibilityState === 'hidden', visible: (rect.bottom > box.top && rect.top < box.bottom) || following, obscured: isObscured(el) });
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

/**
 * Motion pauses while the page is hidden (#593 AC-6). A looping animation is paused and resumed when the page
 * is shown again; a transient one of ours lands on its end state at once, so nothing is half-finished on return.
 * Installed once, before the first render.
 */
let guarded = false;
export function installMotionGuards() {
  if (guarded || typeof document === 'undefined') return;
  guarded = true;
  const paused = new Set<Animation>();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running') continue;
        if (animation.effect?.getComputedTiming().iterations === Infinity) { animation.pause(); paused.add(animation); }
        else if (ours(animation)) animation.finish();
      }
    } else {
      for (const animation of paused) if (animation.playState === 'paused') animation.play();
      paused.clear();
    }
  });
}

// What a person just changed (a task's state, by id), so the new drawing of it can morph even when its element is new:
// a row that moves to another group is built again there, and a new element has no earlier value of its own to compare.
const changed = new Map<string, number>();
const JUST = 1500;
/** Says that the thing `key` names was just changed by the person; what shows it next morphs (see `useMorph`). */
export function noteChange(key: string) { changed.set(key, performance.now()); }
const justChanged = (key?: string) => !!key && performance.now() - (changed.get(key) ?? -Infinity) < JUST;

/**
 * A value that changes in place morphs (#593 AC-4): the element it is drawn in settles in from `from` (a soft
 * fade, optionally a little smaller) instead of jumping. Nothing runs for the first value or with motion off. With
 * `key` (see `noteChange`), an element built for a value the person has just changed morphs on its first drawing too.
 */
export function useMorph<T extends Element>(value: unknown, from: Pose = { opacity: 0.35 }, key?: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  const previous = useRef<{ value: unknown } | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { value };
    if (before ? Object.is(before.value, value) : !justChanged(key)) return;
    void settle(ref.current, { opacity: 1, ...(from.transform ? { transform: 'none' } : {}) }, duration('--dur-in'), '--ease-out', { from });
    // `from` and `key` are constants of the call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return ref;
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
  /** Tablet (Spokój, layout per screen): the sidebar is the 64 px rail and its expand control opens the drawer. */
  tablet: '(max-width: 900px)',
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
