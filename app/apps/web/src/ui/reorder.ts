import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { duration, motionAllowed } from './motion';

/**
 * Reordering a list by hand (#1250, docs/design/motion.md "Reordering spaces"): a drag with a mouse, a long press and then a drag on
 * touch, and the same one-step slide for a move made from the keyboard (`slideRows`). Only `transform` and `opacity` change, from the
 * tokens: the dragged row lifts (`is-lifted`: the `--el` fill, `--sh-pop`), follows the pointer on `translateY`, clamped to the list;
 * the other rows slide out of the way over `--dur-1` on `--ease-out` as it crosses their midpoints, so the gap always shows where it
 * will land (`reorder-slot`); on release it settles into the gap the same way; Esc, a cancelled touch or a release outside the list
 * glides it back. Near the list's top or bottom edge a long list scrolls itself. Nothing scales and nothing is animated with reduced
 * motion (the durations are 0). The first `fixed` rows are never dragged and never passed (Everyone).
 *
 * The rows are real elements that stay where they are in the layout while they move: the list changes only when the drop ends, in one
 * synchronous commit that also clears every inline style, so nothing jumps. A press that does not become a drag is an ordinary click.
 */
export interface ReorderOptions {
  /** The rows, as a selector that matches the list's own children. */
  rows: string;
  idOf(row: HTMLElement): string;
  /** How many leading rows stay where they are. */
  fixed: number;
  /** The row is dropped at the place `to` (counted from 0 among the rows). Called inside `flushSync`: the list is changed when it returns. */
  onMove(id: string, to: number): void;
  enabled?: boolean;
}

/** A mouse starts a drag after this many pixels, so a plain click still opens the row. */
const MOUSE_SLOP = 4;
/** A touch that moves this far before the long press is a scroll. */
const TOUCH_SLOP = 10;
/** How long a touch is held before the row lifts. */
const LONG_PRESS_MS = 450;
/** How near the scrolling area's edge the list scrolls itself, and the most it scrolls in one frame. */
const EDGE = 40;
const SCROLL_STEP = 14;

interface Press { pointerId: number; type: string; x: number; y: number; row: HTMLElement; timer: number }
interface Drag {
  press: Press; rows: HTMLElement[]; from: number; tops: number[]; heights: number[]; gap: number; grab: number; slot: HTMLElement;
  y: number; x: number; target: number; scroller: Element | null; frame: number; ending: boolean;
}

/** The nearest ancestor that scrolls (the document when none does). */
function scrollerOf(el: HTMLElement): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Where row `at` of the new order stands, counted from the list's top: the rows in `order` (their indexes) one under the other. */
function placeOf(drag: Pick<Drag, 'tops' | 'heights' | 'gap'>, order: readonly number[], at: number) {
  let top = drag.tops[0] ?? 0;
  for (let i = 0; i < at; i++) top += drag.heights[order[i]!]! + drag.gap;
  return top;
}

/** The rows' indexes after row `from` is put at `to`. */
function arranged(count: number, from: number, to: number) {
  const order = Array.from({ length: count }, (_, i) => i).filter((i) => i !== from);
  order.splice(to, 0, from);
  return order;
}

export function useReorder(list: RefObject<HTMLElement | null>, options: ReorderOptions) {
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const enabled = options.enabled !== false;

  useEffect(() => {
    const root = list.current;
    if (!root || !enabled) return undefined;
    const container: HTMLElement = root;
    let press: Press | null = null;
    let drag: Drag | null = null;
    let lastTouch = 0;
    const rowsOf = () => [...container.querySelectorAll<HTMLElement>(latest.current.rows)].filter((row) => row.parentElement === container);

    const clearPress = () => { if (press) window.clearTimeout(press.timer); press = null; };

    // The pointer after the press: a drag begins, or the press ends as the click or the scroll it was.
    const onMove = (event: PointerEvent) => {
      if (press && event.pointerId === press.pointerId && !drag) {
        const dist = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (press.type === 'mouse' || press.type === 'pen') { if (dist > MOUSE_SLOP) begin(event.clientX, event.clientY); }
        else if (dist > TOUCH_SLOP) { removeDocument(); clearPress(); }
        return;
      }
      if (drag && event.pointerId === drag.press.pointerId) {
        drag.x = event.clientX;
        drag.y = event.clientY;
        update();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.press.pointerId) { finish(!outside(drag.x, drag.y)); return; }
      if (press && event.pointerId === press.pointerId) { removeDocument(); clearPress(); }
    };
    const onCancel = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.press.pointerId) finish(false);
      else if (press && event.pointerId === press.pointerId) { removeDocument(); clearPress(); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (!drag || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    const onHide = () => { if (document.visibilityState === 'hidden' && drag) finish(false); };
    const addDocument = () => {
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('visibilitychange', onHide);
    };
    function removeDocument() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onHide);
    }

    const onDown = (event: PointerEvent) => {
      if (press || drag || event.button !== 0 || !event.isPrimary) return;
      const target = event.target as Element | null;
      const row = target?.closest<HTMLElement>(latest.current.rows);
      if (!row || row.parentElement !== container) return;
      // The row's own controls (its ⋯) are not a handle.
      if (target?.closest('button, input, select, textarea, [role="menu"]')) return;
      const rows = rowsOf();
      if (rows.indexOf(row) < latest.current.fixed) return;
      const timer = event.pointerType === 'mouse' || event.pointerType === 'pen' ? 0
        : window.setTimeout(() => { if (press && press.timer === timer) begin(press.x, press.y); }, LONG_PRESS_MS);
      press = { pointerId: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, row, timer };
      if (event.pointerType === 'touch') lastTouch = performance.now();
      addDocument();
    };

    function begin(x: number, y: number) {
      if (!press) return;
      const rows = rowsOf();
      const from = rows.indexOf(press.row);
      const lead = latest.current.fixed;
      if (from < lead || rows.length < 2) { removeDocument(); clearPress(); return; }
      const box = container.getBoundingClientRect();
      const rects = rows.map((row) => row.getBoundingClientRect());
      const tops = rects.map((rect) => rect.top - box.top);
      const heights = rects.map((rect) => rect.height);
      const gap = rows.length > 1 ? Math.max(0, tops[1]! - tops[0]! - heights[0]!) : 0;
      const slot = document.createElement('li');
      slot.className = 'reorder-slot';
      slot.setAttribute('aria-hidden', 'true');
      slot.style.height = `${heights[from]}px`;
      slot.style.transform = `translateY(${tops[from]! - container.clientTop}px)`;
      container.append(slot);
      container.setAttribute('data-reordering', '');
      for (const [i, row] of rows.entries()) if (i !== from) row.classList.add('is-sliding');
      press.row.classList.add('is-lifted');
      try { press.row.setPointerCapture(press.pointerId); } catch { /* a pointer that is gone (or one a script made) cannot be captured */ }
      if (press.type === 'touch' && typeof navigator.vibrate === 'function') navigator.vibrate(10);
      drag = { press, rows, from, tops, heights, gap, grab: press.y - rects[from]!.top, slot, y, x, target: from, scroller: scrollerOf(container), frame: 0, ending: false };
      window.clearTimeout(press.timer);
      update();
      edge();
    }

    /** The pointer is over the list's column and the scrolling area it is in. */
    function outside(x: number, y: number) {
      const box = container.getBoundingClientRect();
      const area = drag?.scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      return x < box.left - 12 || x > box.right + 12 || y < area.top - 4 || y > area.bottom + 4;
    }

    /** Places the dragged row under the pointer, and the other rows out of its way. */
    function update() {
      const d = drag;
      if (!d || d.ending) return;
      const n = d.rows.length;
      const box = container.getBoundingClientRect();
      const lead = latest.current.fixed;
      const height = d.heights[d.from]!;
      const bottom = d.tops[n - 1]! + d.heights[n - 1]!;
      const top = Math.min(Math.max(d.y - box.top - d.grab, d.tops[lead] ?? d.tops[0]!), bottom - height);
      const mid = top + height / 2;
      let target = 0;
      for (let i = 0; i < n; i++) if (i !== d.from && d.tops[i]! + d.heights[i]! / 2 < mid) target++;
      d.target = Math.max(lead, target);
      const order = arranged(n, d.from, d.target);
      for (const [at, index] of order.entries()) {
        if (index === d.from) continue;
        const shift = placeOf(d, order, at) - d.tops[index]!;
        d.rows[index]!.style.transform = Math.abs(shift) < 0.5 ? '' : `translateY(${shift}px)`;
      }
      d.rows[d.from]!.style.transform = `translateY(${top - d.tops[d.from]!}px)`;
      d.slot.style.transform = `translateY(${placeOf(d, order, d.target) - container.clientTop}px)`;
    }

    /** A long list scrolls itself while the pointer is held near its top or bottom edge. */
    function edge() {
      const d = drag;
      if (!d || d.ending) return;
      const area = d.scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const speed = d.y < area.top + EDGE ? -Math.min(1, (area.top + EDGE - d.y) / EDGE) : d.y > area.bottom - EDGE ? Math.min(1, (d.y - (area.bottom - EDGE)) / EDGE) : 0;
      if (speed) {
        const was = d.scroller ? d.scroller.scrollTop : window.scrollY;
        const step = Math.round(speed * SCROLL_STEP) || Math.sign(speed);
        if (d.scroller) d.scroller.scrollTop += step; else window.scrollBy(0, step);
        if ((d.scroller ? d.scroller.scrollTop : window.scrollY) !== was) update();
      }
      d.frame = requestAnimationFrame(edge);
    }

    /** The drop: the row settles into the gap (or glides back) over `--dur-1`, then the list is changed in one commit. */
    function finish(commit: boolean) {
      const d = drag;
      if (!d || d.ending) return;
      d.ending = true;
      cancelAnimationFrame(d.frame);
      removeDocument();
      const to = commit ? d.target : d.from;
      const order = arranged(d.rows.length, d.from, to);
      const row = d.rows[d.from]!;
      // The others stand at their places for the target already; a cancelled drag sends them back to where they were.
      for (const [at, index] of order.entries()) {
        if (index === d.from) continue;
        const shift = placeOf(d, order, at) - d.tops[index]!;
        d.rows[index]!.style.transform = Math.abs(shift) < 0.5 ? '' : `translateY(${shift}px)`;
      }
      const shift = placeOf(d, order, to) - d.tops[d.from]!;
      row.classList.add('is-sliding');
      row.style.transform = Math.abs(shift) < 0.5 ? '' : `translateY(${shift}px)`;
      d.slot.style.transform = `translateY(${placeOf(d, order, to) - container.clientTop}px)`;
      // A click that follows the release is the end of the drag, not a choice of the row.
      const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 60);
      let done = false;
      const land = () => {
        if (done) return;
        done = true;
        row.removeEventListener('transitionend', onEnd);
        const id = latest.current.idOf(row);
        // What the drag put on the rows goes first, so the list is measured and drawn as it will stand: the open space's highlight is
        // placed from it when the list changes (ui/motion.ts), and nothing moves once it has.
        for (const one of d.rows) { one.style.transform = ''; one.classList.remove('is-sliding', 'is-lifted'); }
        d.slot.remove();
        container.removeAttribute('data-reordering');
        try { row.releasePointerCapture(d.press.pointerId); } catch { /* already released */ }
        if (to !== d.from) flushSync(() => latest.current.onMove(id, to));
        drag = null;
        clearPress();
      };
      const onEnd = (event: Event) => { if (event.target === row) land(); };
      const ms = duration('--dur-1');
      if (!ms || !motionAllowed() || !shift) { land(); return; }
      row.addEventListener('transitionend', onEnd);
      window.setTimeout(land, ms + 80);
    }

    // The browser must not take a drag for something else: a link starts its own drag-and-drop with a mouse, a long press on a link
    // opens a menu on Android, and a held finger that moves scrolls the list. Once the row has lifted, none of them may happen.
    const onDragStart = (event: Event) => { if (press || drag) event.preventDefault(); };
    const onContextMenu = (event: Event) => { if (drag || (press && press.type === 'touch') || performance.now() - lastTouch < 1200) event.preventDefault(); };
    const onTouchMove = (event: TouchEvent) => { if (drag && event.cancelable) event.preventDefault(); };
    const onSelect = (event: Event) => { if (press || drag) event.preventDefault(); };
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('dragstart', onDragStart);
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('selectstart', onSelect);
    return () => {
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('dragstart', onDragStart);
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('selectstart', onSelect);
      removeDocument();
      if (drag) {
        cancelAnimationFrame(drag.frame);
        for (const one of drag.rows) { one.style.transform = ''; one.classList.remove('is-sliding', 'is-lifted'); }
        drag.slot.remove();
        container.removeAttribute('data-reordering');
      }
      clearPress();
    };
  }, [list, enabled]);
}

/** The rows `slideRows` set sliding, and when each stops (a second move on the same row starts over). */
const sliding = new WeakMap<HTMLElement, number>();

/**
 * A move that is not a drag (a key): `change` puts the rows in their new order, and every row that moved slides from where it was to
 * where it is over `--dur-1` on `--ease-out`, as the rows do in a drag: the same `is-sliding` transition on `transform`. Nothing slides
 * with reduced motion. The change is made at once, inside `flushSync`, so the rows are in place the moment this returns; each moved row
 * is put back where it was without a transition, the layout is read once so that the browser has that start, and only then is it let go.
 */
export function slideRows(list: HTMLElement | null, rows: string, change: () => void) {
  const each = () => [...(list?.querySelectorAll<HTMLElement>(rows) ?? [])].filter((row) => row.parentElement === list);
  const before = new Map<HTMLElement, number>();
  for (const row of each()) before.set(row, row.getBoundingClientRect().top);
  flushSync(change);
  const ms = duration('--dur-1');
  if (!list || !ms || !motionAllowed()) return;
  const moved: HTMLElement[] = [];
  for (const row of each()) {
    const was = before.get(row);
    if (was === undefined) continue;
    const shift = was - row.getBoundingClientRect().top;
    if (Math.abs(shift) < 1) continue;
    row.classList.remove('is-sliding');
    row.style.transform = `translateY(${shift}px)`;
    moved.push(row);
  }
  if (!moved.length) return;
  void list.offsetHeight;
  for (const row of moved) {
    window.clearTimeout(sliding.get(row));
    row.classList.add('is-sliding');
    row.style.transform = '';
    sliding.set(row, window.setTimeout(() => { row.classList.remove('is-sliding'); sliding.delete(row); }, ms + 80));
  }
}

/**
 * A move made from the keyboard (⋯ › Move up / Move down): `move(change, focus)` puts the rows in their new order with `slideRows`, then
 * gives the focus back to the element `focus` selects in the list (the row's own ⋯), wherever the row went.
 */
export function useKeyboardMove(list: RefObject<HTMLElement | null>, rows: string) {
  return (change: () => void, focus: string) => {
    slideRows(list.current, rows, change);
    list.current?.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  };
}
