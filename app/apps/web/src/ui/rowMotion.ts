import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION_ID, duration, motionAllowed, token } from './motion';

/**
 * Rows that come, go and move keep the reader's place (#593 AC-4). An added row grows in (height and opacity), a removed
 * row collapses (height and opacity) where it stood, and a row that moved, or that other rows moved under, slides from
 * where it was to where it is (transform). It is the only animation that touches height, and only to collapse or grow
 * a row. Nothing here moves focus or scroll: the browser's own scroll anchoring keeps the reading position while the
 * rows around it change size, a row slides only by how far it moved on the screen (a row the anchoring kept where the
 * reader sees it does not move at all), and the outgoing row is an inert copy no one can reach.
 *
 * Call it with the list's container; `rows` selects the rows, `key` names a row (its id), and `scope` names the view
 * the rows belong to: when it changes (another filter, List to Board) the rows are simply replaced, never animated.
 *
 * It does nothing at all in a commit that left the rows as they were (no layout is read and no running animation is
 * touched), and in a commit that changed them it reads every position once, writes, reads the rows that stayed once
 * more and writes again: never a read between two writes per row.
 */
interface Seen { el: HTMLElement; left: number; top: number; height: number; parent: HTMLElement; next: Element | null; prev: Element | null }
interface Last { scope: string; signature: string; seen: Map<string, Seen>; scroll: number }

const GHOST = 'data-row-ghost';
/** The most rows that may arrive or leave in one change and still be animated one by one. */
const MOST = 4;
// Properties a row's own box adds to its height; they shrink with it so a padded row collapses to nothing.
const BOX = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth'] as const;

/** Where a row is in the layout, not where an animation currently draws it. */
function place(el: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) { left += node.offsetLeft; top += node.offsetTop; }
  return { left, top };
}

/** The nearest ancestor that scrolls the rows (the pane's own scroller, or the page). */
function scrollerOf(el: HTMLElement): Element {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

const parents = new WeakMap<Element, number>();
let parentCount = 0;
const parentId = (el: Element | null) => { if (!el) return -1; let id = parents.get(el); if (id === undefined) { id = parentCount += 1; parents.set(el, id); } return id; };

export function useRowMotion(container: RefObject<HTMLElement | null>, rows: string, key: (el: HTMLElement) => string | undefined, scope = '') {
  const last = useRef<Last | null>(null);
  const resized = useRef(false);
  // How far the reader had scrolled the rows before the commit that changes them (a scroll event lands after the frame it scrolled, so it
  // still names the position before this commit's layout, and before any anchoring adjustment).
  const reading = useRef(0);
  // After the window has been resized the rows are somewhere else than the last reading says.
  useEffect(() => {
    const stale = () => { resized.current = true; };
    const follow = (event: Event) => {
      const root = container.current;
      const target = event.target === document ? document.scrollingElement : event.target;
      if (root && target instanceof Element && target.contains(root)) reading.current = target.scrollTop;
    };
    window.addEventListener('resize', stale);
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => { window.removeEventListener('resize', stale); document.removeEventListener('scroll', follow, { capture: true }); };
    // The container is a ref: read when the event comes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const root = container.current;
    const out = duration('--dur-out');
    const inn = duration('--dur-in');
    // Under reduced motion nothing is read at all; the next change with motion on starts afresh.
    if (!root || !out || !inn) { last.current = null; return; }
    const elements = [...root.querySelectorAll<HTMLElement>(rows)].filter((el) => !el.hasAttribute(GHOST) && key(el) && el.parentElement);
    const signature = elements.map((el) => `${key(el)}@${parentId(el.parentElement)}`).join('|');
    const before = last.current;
    if (before && before.scope === scope && before.signature === signature && !resized.current) return;
    // A row that comes back while its outgoing copy is still collapsing (an undone removal) replaces it at once.
    const present = new Set(elements.map((el) => key(el)));
    for (const ghost of root.querySelectorAll(`[${GHOST}]`)) if (present.has(ghost.getAttribute(GHOST) ?? '')) ghost.remove();

    // The rows were changed: where every one of them is now, in one pass of reads.
    const seen = new Map<string, Seen>();
    for (const el of elements) {
      const at = place(el);
      seen.set(key(el)!, { el, left: at.left, top: at.top, height: el.offsetHeight, parent: el.parentElement!, next: el.nextElementSibling, prev: el.previousElementSibling });
    }
    // Where the reader is looking: a row's place on the screen is its place in the content less how far the content is scrolled. The browser's
    // own scroll anchoring has already kept the reading position through this change (the layout was read just above), so a row that stayed
    // where the reader sees it is still, whatever moved above it.
    const prior = reading.current || before?.scroll || 0;
    const scroll = scrollerOf(root).scrollTop;
    reading.current = scroll;
    last.current = { scope, signature, seen, scroll };
    const fresh = resized.current;
    resized.current = false;
    // What the first screen shows, a hidden page, another view or a resized window is only read: it is where the next change starts from.
    if (!before || before.scope !== scope || fresh || !motionAllowed()) return;

    // Rows that come and go a few at a time are changes the reader should follow; a screenful at once is a load, a
    // page or a new filter, which only replaces them.
    const arrived = [...seen.keys()].filter((id) => !before.seen.has(id));
    const left = [...before.seen.keys()].filter((id) => !seen.has(id));
    const bulk = arrived.length > MOST || left.length > MOST || before.seen.size === 0;
    const easeOut = token('--ease-out') || 'ease-out';
    const easeIn = token('--ease-in') || 'ease-in';
    const writes: (() => void)[] = [];

    // Rows that left collapse where they stood: an inert copy of each goes back in and shrinks away.
    if (!bulk) for (const id of left) {
      const gone = before.seen.get(id)!;
      if (!gone.parent.isConnected || gone.height <= 0 || gone.el.isConnected) continue;
      // A copy, never the node React took out: React stays free to build and remove its own rows around it.
      const ghost = gone.el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('id');
      for (const inner of ghost.querySelectorAll('[id]')) inner.removeAttribute('id');
      ghost.setAttribute(GHOST, id);
      ghost.setAttribute('inert', '');
      ghost.setAttribute('aria-hidden', 'true');
      const reference = gone.next && gone.next.parentNode === gone.parent ? gone.next : null;
      if (reference) gone.parent.insertBefore(ghost, reference);
      else if (gone.prev && gone.prev.parentNode === gone.parent) gone.prev.after(ghost);
      else gone.parent.appendChild(ghost);
      const style = getComputedStyle(ghost);
      const start: Keyframe = { height: `${gone.height}px`, opacity: 1 };
      const end: Keyframe = { height: '0px', opacity: 0 };
      for (const prop of BOX) { start[prop] = style[prop]; end[prop] = '0px'; }
      ghost.style.overflow = 'hidden';
      const collapse = ghost.animate([start, end], { duration: out, easing: easeIn, fill: 'forwards' });
      collapse.id = MOTION_ID;
      void collapse.finished.then(() => ghost.remove(), () => ghost.remove());
    }

    // Rows that arrived grow to their height.
    if (!bulk) for (const id of arrived) {
      const row = seen.get(id)!;
      const style = getComputedStyle(row.el);
      const start: Keyframe = { height: '0px', opacity: 0 };
      const end: Keyframe = { height: `${row.height}px`, opacity: 1 };
      for (const prop of BOX) { start[prop] = '0px'; end[prop] = style[prop]; }
      const previousOverflow = row.el.style.overflow;
      row.el.style.overflow = 'hidden';
      const grow = row.el.animate([start, end], { duration: inn, easing: easeOut });
      grow.id = MOTION_ID;
      const done = () => { row.el.style.overflow = previousOverflow; };
      void grow.finished.then(done, done);
    }

    // Rows that stayed, or moved to another group, slide from where they were to where they are: read where each one is
    // now (the copies and the growing rows are in place), then write every slide.
    const view = root.closest<HTMLElement>('.pane-scroll')?.getBoundingClientRect() ?? root.getBoundingClientRect();
    const reach = view.height + 200;
    const slides: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const [id, now] of seen) {
      const was = before.seen.get(id);
      if (!was) continue;
      const at = place(now.el);
      const dx = was.left - at.left;
      const dy = (was.top - prior) - (at.top - scroll);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // Only rows a reader can see or is about to see are worth moving.
      const box = now.el.getBoundingClientRect();
      if (box.bottom < view.top - reach || box.top > view.bottom + reach) continue;
      slides.push({ el: now.el, dx, dy });
    }
    writes.push(() => {
      const ms = duration('--dur-3');
      const easing = token('--ease-sheet') || 'ease-out';
      for (const { el, dx, dy } of slides) {
        for (const running of el.getAnimations()) if (running.id === MOTION_ID && !(running.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => 'height' in frame)) running.cancel();
        const slide = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing });
        slide.id = MOTION_ID;
      }
    });
    for (const write of writes) write();
  });
}
