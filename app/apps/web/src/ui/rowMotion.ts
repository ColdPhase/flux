import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION_ID, claimInput, duration, motionAllowed, token } from './motion';

/**
 * Rows that come, go and move keep the reader's place (#593 AC-4; #863 rule 8: no row animates `height`). An added row fades in where
 * it stands, a removed row is simply gone, and every row that moved, or that other rows moved under (the ones below an added or a
 * removed row), slides from where it was to where it is (transform). So the rows around a change close up or open up as one
 * slide, and a row never grows or collapses. A row that moves across the list instead of a few rows (to another group) is not carried
 * the whole way: it fades in at its new place with a short slide (`--row-travel-max`, `--shift-row`). Nothing here moves focus or scroll: the browser's
 * own scroll anchoring keeps the reading position while the rows around it change size, a row slides only by how far it moved relative
 * to the rows the reader is anchored to (those that moved with it do not move at all; a list at its top is not anchored and slides as a
 * whole), and a row that comes, goes or moves outside what the reader sees changes at once (nobody watches it).
 *
 * A row moves only as the answer to the person's own input (`claimInput`, #863): the first change of the rows after it is the action's one
 * motion, and the server's echo of it, a refetch or a live update changes the rows without replaying it. A list that has just appeared
 * (its first `LOAD_MS`) is still loading: rows that arrive in it are the view's first appearance, which never animates.
 *
 * Call it with the list's container; `rows` selects the rows, `key` names a row (its id), and `scope` names the view
 * the rows belong to: when it changes (another filter, List to Board) the rows are simply replaced, never animated.
 *
 * It does nothing at all in a commit that left the rows as they were (no layout is read and no running animation is
 * touched), and in a commit that changed them it reads every position once, writes, reads the rows that stayed once
 * more and writes again: never a read between two writes per row.
 */
interface Seen { el: HTMLElement; left: number; top: number; parent: HTMLElement }
interface Last { scope: string; signature: string; seen: Map<string, Seen> }

/** How long a list that has just mounted is still loading its rows (its groups arrive one by one): they take their places without motion. */
const LOAD_MS = 700;
/** The most rows that may arrive or leave in one change and still be animated one by one. */
const MOST = 4;
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
  const mountedAt = useRef<number | null>(null);
  // After the window has been resized the rows are somewhere else than the last reading says.
  useEffect(() => {
    const stale = () => { resized.current = true; };
    window.addEventListener('resize', stale);
    return () => window.removeEventListener('resize', stale);
  }, []);
  useLayoutEffect(() => {
    mountedAt.current ??= performance.now();
    const root = container.current;
    const inn = duration('--dur-in');
    // Under reduced motion nothing is read at all; the next change with motion on starts afresh.
    if (!root || !inn) { last.current = null; return; }
    const elements = [...root.querySelectorAll<HTMLElement>(rows)].filter((el) => key(el) && el.parentElement);
    const signature = elements.map((el) => `${key(el)}@${parentId(el.parentElement)}`).join('|');
    const before = last.current;
    if (before && before.scope === scope && before.signature === signature && !resized.current) return;
    // The rows were changed: where every one of them is now, in one pass of reads.
    const seen = new Map<string, Seen>();
    for (const el of elements) {
      const at = place(el);
      seen.set(key(el)!, { el, left: at.left, top: at.top, parent: el.parentElement! });
    }
    last.current = { scope, signature, seen };
    const fresh = resized.current;
    resized.current = false;
    // What the first screen shows, a hidden page, another view or a resized window is only read: it is where the next change starts from.
    if (!before || before.scope !== scope || fresh || !motionAllowed() || performance.now() - (mountedAt.current ?? 0) < LOAD_MS) return;

    // Rows that come and go a few at a time are changes the reader should follow; a screenful at once is a load, a
    // page or a new filter, which only replaces them.
    const arrived = [...seen.keys()].filter((id) => !before.seen.has(id));
    const left = [...before.seen.keys()].filter((id) => !seen.has(id));
    const bulk = arrived.length > MOST || left.length > MOST || before.seen.size === 0;
    // The person's input is answered once; what follows it (the echo, a refetch, a live update) only changes the rows.
    if (!claimInput()) return;
    const easeOut = token('--ease-out') || 'ease-out';
    const writes: (() => void)[] = [];
    // What the reader can see. A row that comes outside it is not worth animating: nobody watches it. It changes at once, which the browser's
    // scroll anchoring holds.
    const view = root.closest<HTMLElement>('.pane-scroll')?.getBoundingClientRect() ?? root.getBoundingClientRect();
    const unseen = (box: DOMRect) => box.bottom < view.top || box.top > view.bottom;

    // Rows that arrived fade in where they stand (the rows below them slide, below).
    if (!bulk) for (const id of arrived) {
      const row = seen.get(id)!;
      if (unseen(row.el.getBoundingClientRect())) continue;
      const fade = row.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: inn, easing: easeOut });
      fade.id = MOTION_ID;
    }

    // Rows that stayed, or moved to another group, slide from where they were to where they are: read where each one is
    // now, then write every slide.
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
      const ms = duration('--dur-in');
      const easing = token('--ease-out') || 'ease-out';
      // Motion is short and calm (final design §2): a row that moves a few rows slides there, a row that moves across the list (to another
      // group, far from where it was) is not carried the whole way: it comes in at its new place with a short slide from the side it came from.
      const farther = parseFloat(token('--row-travel-max')) || 160;
      const shift = parseFloat(token('--shift-row')) || 12;
      for (const { el, dx, dy } of slides) {
        for (const running of el.getAnimations()) if (running.id === MOTION_ID) running.cancel();
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
