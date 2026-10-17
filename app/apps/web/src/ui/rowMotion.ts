import { useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION_ID, cancelMotion, duration, motionAllowed, token } from './motion';

/**
 * Rows that come, go and move keep the reader's place (#593 AC-4). An added row grows in (height and opacity), a removed
 * row collapses (height and opacity) where it stood, and a row that moved, or that other rows moved under, slides from
 * where it was to where it is (transform). It is the only animation that touches height, and only to collapse or grow
 * a row. Nothing here moves focus or scroll: the browser's own scroll anchoring keeps the reading position while the
 * rows around it change size, and the outgoing row is an inert copy no one can reach.
 *
 * Call it with the list's container; `rows` selects the rows, `key` names a row (its id), and `scope` names the view
 * the rows belong to: when it changes (another filter, List to Board) the rows are simply replaced, never animated.
 * It reads layout after every commit of its component, so keep it on screens whose rows change a few at a time.
 */
interface Seen { el: HTMLElement; left: number; top: number; height: number; parent: HTMLElement; next: Element | null; prev: Element | null }

const GHOST = 'data-row-ghost';
/** The most rows that may arrive or leave in one change and still be animated one by one. */
const MOST = 4;
// Properties a row's own box adds to its height; they shrink with it so a padded row collapses to nothing.
const BOX = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth'] as const;

function collect(root: HTMLElement, scroller: HTMLElement, rows: string, key: (el: HTMLElement) => string | undefined): Map<string, Seen> {
  const found = new Map<string, Seen>();
  const base = scroller.getBoundingClientRect();
  for (const el of root.querySelectorAll<HTMLElement>(rows)) {
    if (el.hasAttribute(GHOST)) continue;
    const id = key(el);
    const parent = el.parentElement;
    if (!id || !parent) continue;
    const box = el.getBoundingClientRect();
    found.set(id, { el, left: box.left - base.left + scroller.scrollLeft, top: box.top - base.top + scroller.scrollTop, height: box.height, parent, next: el.nextElementSibling, prev: el.previousElementSibling });
  }
  return found;
}

export function useRowMotion(container: RefObject<HTMLElement | null>, rows: string, key: (el: HTMLElement) => string | undefined, scope = '') {
  const last = useRef<{ scope: string; seen: Map<string, Seen> } | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) { last.current = null; return; }
    const scroller = root.closest<HTMLElement>('.pane-scroll') ?? root;
    // Whatever ours was still running ends on its layout position first, so every measurement below is layout.
    for (const el of root.querySelectorAll<HTMLElement>(rows)) cancelMotion(el);
    const seen = collect(root, scroller, rows, key);
    const before = last.current;
    last.current = { scope, seen };
    const out = duration('--dur-out');
    const inn = duration('--dur-in');
    if (!before || before.scope !== scope || !motionAllowed() || !out || !inn) return;
    // Rows that come and go a few at a time are changes the reader should follow; a screenful at once is a load, a
    // page or a new filter, which only replaces them.
    const arrived = [...seen.keys()].filter((id) => !before.seen.has(id)).length;
    const left = [...before.seen.keys()].filter((id) => !seen.has(id)).length;
    const bulk = arrived > MOST || left > MOST || before.seen.size === 0;
    const easeOut = token('--ease-out') || 'ease-out';
    const easeIn = token('--ease-in') || 'ease-in';

    // Rows that left collapse where they stood: their old element goes back in, inert, and shrinks away.
    for (const [id, gone] of before.seen) {
      if (bulk || seen.has(id) || !gone.parent.isConnected || gone.height <= 0 || gone.el.isConnected) continue;
      const ghost = gone.el;
      ghost.setAttribute(GHOST, '');
      ghost.setAttribute('inert', '');
      ghost.setAttribute('aria-hidden', 'true');
      const reference = gone.next && gone.next.parentNode === gone.parent ? gone.next : null;
      if (reference) gone.parent.insertBefore(ghost, reference);
      else if (gone.prev && gone.prev.parentNode === gone.parent) gone.prev.after(ghost);
      else gone.parent.appendChild(ghost);
      const style = getComputedStyle(ghost);
      const start: Keyframe = { height: `${ghost.getBoundingClientRect().height}px`, opacity: 1 };
      const end: Keyframe = { height: '0px', opacity: 0 };
      for (const prop of BOX) { start[prop] = style[prop]; end[prop] = '0px'; }
      const previousOverflow = ghost.style.overflow;
      ghost.style.overflow = 'hidden';
      const collapse = ghost.animate([start, end], { duration: out, easing: easeIn, fill: 'forwards' });
      collapse.id = MOTION_ID;
      void collapse.finished.then(() => ghost.remove(), () => { ghost.style.overflow = previousOverflow; ghost.remove(); });
    }

    // Rows that arrived grow to their height.
    for (const [id, row] of seen) {
      if (bulk || before.seen.has(id)) continue;
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

    // Rows that stayed, or moved to another group, slide from where they were to where they are.
    const view = scroller.getBoundingClientRect();
    const reach = view.height + 200;
    const base = view;
    for (const [id, now] of seen) {
      const was = before.seen.get(id);
      if (!was) continue;
      const box = now.el.getBoundingClientRect();
      const dx = was.left - (box.left - base.left + scroller.scrollLeft);
      const dy = was.top - (box.top - base.top + scroller.scrollTop);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // Only rows a reader can see or is about to see are worth moving.
      if (box.bottom < view.top - reach || box.top > view.bottom + reach) continue;
      const slide = now.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: duration('--dur-3'), easing: token('--ease-sheet') || 'ease-out' });
      slide.id = MOTION_ID;
    }
  });
}
