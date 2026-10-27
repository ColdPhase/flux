import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION_ID, duration, motionAllowed, token } from './motion';

/**
 * Rows that come, go and move keep the reader's place (#593 AC-4). An added row grows in (height and opacity), a removed
 * row collapses (height and opacity) where it stood, and a row that moved, or that other rows moved under, slides from
 * where it was to where it is (transform). It is the only animation that touches height, and only to collapse or grow
 * a row. A row that moves across the list instead of a few rows (to another group) is not carried the whole way: it fades in at
 * its new place with a short slide (`--row-travel-max`, `--shift-row`). Nothing here moves focus or scroll: the browser's own scroll anchoring keeps the reading position while the
 * rows around it change size, a row slides only by how far it moved relative to the rows the reader is anchored to (those
 * that moved with it do not move at all; a list at its top is not anchored and slides as a whole), a row that comes or goes outside what the reader sees changes at once
 * (nobody watches it, and the browser's scroll anchoring holds the rows the reader is on through a change that is not gradual),
 * and the outgoing row is an inert copy no one can reach.
 *
 * Call it with the list's container; `rows` selects the rows, `key` names a row (its id), and `scope` names the view
 * the rows belong to: when it changes (another filter, List to Board) the rows are simply replaced, never animated.
 *
 * It does nothing at all in a commit that left the rows as they were (no layout is read and no running animation is
 * touched), and in a commit that changed them it reads every position once, writes, reads the rows that stayed once
 * more and writes again: never a read between two writes per row.
 */
interface Seen { el: HTMLElement; left: number; top: number; height: number; parent: HTMLElement; next: Element | null; prev: Element | null }
interface Last { scope: string; signature: string; seen: Map<string, Seen> }

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
  // After the window has been resized the rows are somewhere else than the last reading says.
  useEffect(() => {
    const stale = () => { resized.current = true; };
    window.addEventListener('resize', stale);
    return () => window.removeEventListener('resize', stale);
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
    last.current = { scope, signature, seen };
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
    // What the reader can see. A row that comes or goes outside it is not worth animating: nobody watches it, and growing or collapsing it
    // gradually would only make the browser's scroll anchoring chase the rows the reader is on. It changes at once, which anchoring holds.
    const view = root.closest<HTMLElement>('.pane-scroll')?.getBoundingClientRect() ?? root.getBoundingClientRect();
    const unseen = (box: DOMRect) => box.bottom < view.top || box.top > view.bottom;

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
      if (unseen(ghost.getBoundingClientRect())) { ghost.remove(); continue; }
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
      if (unseen(row.el.getBoundingClientRect())) continue;
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
    const reach = view.height + 200;
    const slides: { el: HTMLElement; dx: number; dy: number }[] = [];
    // The reader's place. When the rows are scrolled (the browser anchors a scrolled list, never one at its top), the browser's own scroll
    // anchoring keeps one of the rows that stayed where the reader sees it, whatever grew or shrank above it: every row is then judged by how
    // far it moved relative to the rows that moved with that one (the most common displacement among the rows on screen), not by how far the
    // content shifted. The rows the reader is on do not fly; the row that was sent somewhere else, which moved differently, does.
    // Without anchoring (a list at its top, a browser without it) the content stays where the change put it and every row slides from where it was.
    const scrolled = scrollerOf(root).scrollTop > 0;
    const anchoring = scrolled && typeof CSS !== 'undefined' && CSS.supports('overflow-anchor', 'auto');
    const visible = (el: HTMLElement) => { const box = el.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom; };
    const shifts = anchoring ? [...seen].filter(([id, now]) => before.seen.get(id)?.parent === now.parent && visible(now.el)).map(([id, now]) => Math.round(place(now.el).top - before.seen.get(id)!.top)) : [];
    const counts = new Map<number, number>();
    for (const shift of shifts) counts.set(Math.round(shift / 2), (counts.get(Math.round(shift / 2)) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1] || 0)[0]?.[0];
    const anchorShift = common === undefined ? 0 : shifts.find((shift) => Math.round(shift / 2) === common) ?? 0;
    for (const [id, now] of seen) {
      const was = before.seen.get(id);
      if (!was) continue;
      const at = place(now.el);
      const dx = was.left - at.left;
      const dy = was.top - at.top + anchorShift;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // Only rows a reader can see or is about to see are worth moving.
      const box = now.el.getBoundingClientRect();
      if (box.bottom < view.top - reach || box.top > view.bottom + reach) continue;
      slides.push({ el: now.el, dx, dy });
    }
    writes.push(() => {
      const ms = duration('--dur-3');
      const easing = token('--ease-sheet') || 'ease-out';
      // Motion is short and calm (final design §2): a row that moves a few rows slides there, a row that moves across the list (to another
      // group, far from where it was) is not carried the whole way: it comes in at its new place with a short slide from the side it came from.
      const farther = parseFloat(token('--row-travel-max')) || 160;
      const shift = parseFloat(token('--shift-row')) || 12;
      for (const { el, dx, dy } of slides) {
        for (const running of el.getAnimations()) if (running.id === MOTION_ID && !(running.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => 'height' in frame)) running.cancel();
        const far = Math.hypot(dx, dy);
        const slide = far > farther
          ? el.animate([{ opacity: 0, transform: `translate(${(dx / far) * shift}px, ${(dy / far) * shift}px)` }, { opacity: 1, transform: 'none' }], { duration: duration('--dur-in'), easing: token('--ease-out') || 'ease-out' })
          : el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing });
        slide.id = MOTION_ID;
      }
    });
    for (const write of writes) write();
  });
}
