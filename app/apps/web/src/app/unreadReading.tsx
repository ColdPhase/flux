import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';
import { newBelowText } from '../ui/motion-rules';
import { readerActive, watchReaderInput } from '../work/readerIntent';
import './unread-reading.css';

/**
 * Opening a conversation where the person left off (#1246), one behaviour for every surface that reads a feed of messages: a space's
 * conversation, a direct message, a thread, a task's discussion and an agent's chat.
 *  - A quiet "New" divider stands above the first message that is new to them, and opening scrolls to it (the feed's own end when
 *    nothing is new). Each surface says which message that is, from its own read; this file draws it and scrolls to it.
 *  - While they read above the end, what arrives is counted in "↓ 3 new" at the foot of the feed. A click or tap goes to the end, and so
 *    does End; the line goes when they reach the end. Nothing moves under a reader who is above it.
 * It makes no request of its own: every surface reads what it already reads.
 */

/** Within this many pixels of the end a feed counts as being at the end, as the stream always has. */
const END_SLACK = 48;
/** Where the divider lands when opening scrolls to it: a little below the feed's top, so the message above it is not cut off by a hair. */
const TOP_GAP = 12;
/** How long the divider keeps its place while late layout (previews, chips, fonts) settles, unless the reader acts first. */
const HOLD_MS = 2000;

/** A quiet divider where what is new begins: one rule with a word, like a day line (final design §5, S23). */
export function UnreadDivider() {
  return <li className="convo-unread" data-unread-start="" role="separator" aria-label="New"><span>New</span></li>;
}

/** The "↓ 3 new" line over the foot of a feed. It takes no layout space and is announced once per change. Its frame is `.convo-stream`. */
export function NewBelow({ count, onClick }: { count: number; onClick: () => void }) {
  const text = newBelowText(count);
  return (
    <p className="convo-newbelow" role="status" aria-live="polite">
      {text ? <button type="button" className="convo-newbelow__b" aria-label={`${text}. Go to the newest`} onClick={onClick}><Icon name="chevron-down" size={14} />{text}</button> : null}
    </p>
  );
}

const atEnd = (feed: HTMLElement) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < END_SLACK;

/** The entries among `ids` that begin below the visible part of the feed: the ones a reader above its end has not seen. */
export function countBelow(feed: HTMLElement | null, ids: readonly string[], elementFor: (id: string) => HTMLElement | null): number {
  if (!feed) return 0;
  const bottom = feed.getBoundingClientRect().bottom;
  return ids.filter((id) => (elementFor(id)?.getBoundingClientRect().top ?? 0) >= bottom - 1).length;
}

const holds = new WeakMap<HTMLElement, () => void>();
/** The person moved to the end themselves (the line, End): opening no longer keeps the divider where it put it. */
function endOpening(feed: HTMLElement) { holds.get(feed)?.(); }

/**
 * Opens a feed on its "New" divider (`data-unread-start`): the divider goes to the top, with what is new below it. When the divider starts the
 * list (nothing has been read: a conversation never opened), the feed opens at its very top instead, so what stands above the list (who is in
 * a direct message, a thread's root, an agent's note) is in view too. Layout settles for a
 * moment after a feed opens (previews, chips and fonts arrive), so this repeats until the reader acts or {@link HOLD_MS} passes, like
 * `openOnWholeMessages`. It does nothing when the feed has no divider. Returns the cleanup, or null when there was no divider.
 */
export function openAtUnread(feed: HTMLElement, column: HTMLElement | null): (() => void) | null {
  const divider = () => feed.querySelector<HTMLElement>('[data-unread-start]');
  if (!divider()) return null;
  let written = Number.NaN;
  /** Nothing but a day line stands before it in its list. */
  const startsList = (mark: HTMLElement) => {
    const before = mark.previousElementSibling;
    return !before || (before.classList.contains('message-day') && !before.previousElementSibling);
  };
  const place = () => {
    const mark = divider();
    if (!mark) return;
    if (startsList(mark)) feed.scrollTop = 0;
    else feed.scrollTop += mark.getBoundingClientRect().top - feed.getBoundingClientRect().top - TOP_GAP;
    written = feed.scrollTop;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(feed);
  if (column) observer.observe(column);
  const stop = () => { observer.disconnect(); holds.delete(feed); };
  const release = watchReaderInput(feed, stop);
  const moved = () => { if (Math.abs(feed.scrollTop - written) > 1 && readerActive(feed)) stop(); };
  const timer = window.setTimeout(stop, HOLD_MS);
  feed.addEventListener('scroll', moved, { passive: true });
  holds.set(feed, stop);
  return () => { stop(); release(); window.clearTimeout(timer); feed.removeEventListener('scroll', moved); };
}

/**
 * What arrives below a reader who is above the end of `feed`, and the way to the end (the "↓ N new" line). `add` is told how many
 * entries arrived below the visible part; reaching the end clears the count, whoever got the reader there.
 */
export function useNewBelow(feed: HTMLElement | null) {
  const [count, setCount] = useState(0);
  const node = useRef(feed);
  useEffect(() => { node.current = feed; }, [feed]);
  const add = useCallback((more: number) => { if (more > 0) setCount((current) => current + more); }, []);
  useEffect(() => {
    if (!feed) return;
    const reached = () => { if (atEnd(feed)) setCount(0); };
    feed.addEventListener('scroll', reached, { passive: true });
    return () => feed.removeEventListener('scroll', reached);
  }, [feed]);
  const toEnd = useCallback(() => {
    const el = node.current;
    if (!el) return;
    endOpening(el);
    el.scrollTop = el.scrollHeight;
    setCount(0);
  }, []);
  useEndKey(feed, count > 0, toEnd);
  return { count, add, toEnd };
}

/**
 * End goes to the end of the feed while the "N new" line is showing: for a person who reads with the keyboard. Typing in a field, a
 * dialog, another view and a feed that is not on screen keep their own End.
 */
function useEndKey(feed: HTMLElement | null, active: boolean, toEnd: () => void) {
  const latest = useRef(toEnd);
  useEffect(() => { latest.current = toEnd; });
  useEffect(() => {
    if (!feed || !active) return;
    const press = (event: KeyboardEvent) => {
      if (event.key !== 'End' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="textbox"]')) return;
      // Only the surface the person is in: focus inside it, or nowhere in particular (the page itself).
      const surface = feed.parentElement ?? feed;
      const nowhere = !target || target === document.body || target === document.documentElement;
      if (!nowhere && !surface.contains(target)) return;
      if (!feed.getClientRects().length || getComputedStyle(feed).visibility === 'hidden' || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [feed, active]);
}
