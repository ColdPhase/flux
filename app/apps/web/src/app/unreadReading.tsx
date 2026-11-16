import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';
import { newBelowText } from '../ui/motion-rules';
import { readerActive, watchReaderInput } from '../work/readerIntent';
import { isTyping } from '../ui/keys';
import './unread-reading.css';

/**
 * Opening a conversation where the person left off (#1246), one behaviour for every surface that reads a feed of messages: a space's
 * conversation, a direct message, a thread, a task's discussion and an agent's chat.
 *  - A quiet "New" divider stands above the first message that is new to them, and opening scrolls to it (the feed's own end when
 *    nothing is new). Each surface says which message that is, from its own read; this file draws it and scrolls to it.
 *  - While they read above the end, what arrives is counted in "↓ 3 new" at the foot of the feed. A click or tap goes to the end, and so
 *    does End; the line goes when they reach the end. Nothing moves under a reader who is above it.
 *  - Opening on the divider with some of what is new below the visible part shows the line at once, counting all that is new (personas-35:
 *    a long conversation never opened says how much is below it, and End or the line leads to its end).
 * It makes no request of its own: every surface reads what it already reads.
 */

/** Within this many pixels of the end a feed counts as being at the end, as the stream always has. */
export const END_SLACK = 48;
/** Where the divider lands when opening scrolls to it: a little below the feed's top, so the message above it is not cut off by a hair. */
const TOP_GAP = 12;
/** How long the divider keeps its place while late layout (previews, chips, fonts) settles, unless the reader acts first. */
const HOLD_MS = 2000;
/**
 * Opening on the first new message that is older than the newest window reads back at most this many pages (100 messages each; #862's
 * request budget: a conversation never opened is all new, however long). Past that, the divider goes above the oldest message loaded: all
 * of what is loaded is new, and "Show earlier" is above it.
 */
export const UNREAD_READ_BACK = 2;

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
export function arrivedBelow(feed: HTMLElement | null, ids: readonly string[], elementFor: (id: string) => HTMLElement | null): string[] {
  if (!feed) return [];
  const bottom = feed.getBoundingClientRect().bottom;
  return ids.filter((id) => (elementFor(id)?.getBoundingClientRect().top ?? 0) >= bottom - 1);
}

/** The newest message of a feed, or the feed itself when its entries cannot take focus (an agent's chat). */
function newest(feed: HTMLElement): HTMLElement | null {
  const last = [...feed.querySelectorAll<HTMLElement>('li[tabindex="-1"]')].filter((item) => item.getClientRects().length).at(-1);
  if (last) return last;
  feed.tabIndex = -1;
  return feed;
}

const holds = new WeakMap<HTMLElement, () => void>();
/** The "↓ N new" of each feed, told what is new on opening: by `useNewBelow`, or kept here until it has the feed. */
const counters = new WeakMap<HTMLElement, (ids: readonly string[]) => void>();
const waiting = new WeakMap<HTMLElement, readonly string[]>();
function countOnOpening(feed: HTMLElement, ids: readonly string[]) {
  const add = counters.get(feed);
  if (add) add(ids); else waiting.set(feed, ids);
}

/**
 * What "↓ N new" counts on opening, in every feed: a message by someone else (not the reader's own, not a note that AI was used), a task line of a
 * space and what an agent said. Each is counted by the key its feed counts arrivals with: its id, or an agent's line or run.
 */
const COUNTED = '[data-message-id]:not(.is-mine, .dm-notice), .convo-notice[id], [data-chat-agent]';
const countKey = (element: HTMLElement) => element.id
  || (element.dataset.lineId ? `line-${element.dataset.lineId}` : element.dataset.runId ? `run-${element.dataset.runId}` : '');
/** The person moved to the end themselves (the line, End): opening no longer keeps the divider where it put it. */
function endOpening(feed: HTMLElement) { holds.get(feed)?.(); }

/**
 * Opens a feed on its "New" divider (`data-unread-start`): the divider goes to the top, with what is new below it. When the divider starts the
 * list (nothing has been read: a conversation never opened), the feed opens at its very top instead, so what stands above the list (who is in
 * a direct message, a thread's root, an agent's note) is in view too. Layout settles for a
 * moment after a feed opens (previews, chips and fonts arrive), so this repeats until the reader acts or {@link HOLD_MS} passes, like
 * `openOnWholeMessages`. It does nothing when the feed has no divider. Returns the cleanup, or null when there was no divider.
 * What stands after the divider is new: when any of it is below the visible part once the feed is placed, "↓ N new" counts all of it from
 * the start (S23: "↓ N new leads to the end"; personas-35: a long conversation never opened said nothing of what was below it).
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
  const mark = divider();
  if (mark) {
    const fresh = [...feed.querySelectorAll<HTMLElement>(COUNTED)].filter((element) => !!(mark.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) && countKey(element));
    const bottom = feed.getBoundingClientRect().bottom;
    if (fresh.some((element) => element.getBoundingClientRect().top >= bottom - 1)) countOnOpening(feed, [...new Set(fresh.map(countKey))]);
  }
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
 * What arrives below a reader who is above the end of `feed`, and the way to the end (the "↓ N new" line). `add` is told which
 * entries arrived below the visible part; reaching the end clears them, whoever got the reader there. With `present` (the feed's entries
 * now), one that left the feed again, such as a task whose creation was undone, is no longer counted (personas-28).
 */
export function useNewBelow(feed: HTMLElement | null, onToEnd?: () => void, present?: readonly string[]) {
  const [below, setBelow] = useState<readonly string[]>([]);
  const count = present ? below.filter((id) => present.includes(id)).length : below.length;
  const node = useRef(feed);
  const told = useRef(onToEnd);
  useEffect(() => { node.current = feed; told.current = onToEnd; });
  const add = useCallback((ids: readonly string[]) => {
    if (ids.length) setBelow((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
  }, []);
  useEffect(() => {
    if (!feed) return;
    counters.set(feed, add);
    const kept = waiting.get(feed);
    waiting.delete(feed);
    // What opening counted before this feed was known here joins the line on the next frame.
    const frame = kept ? requestAnimationFrame(() => { if (!atEnd(feed)) add(kept); }) : 0;
    return () => { cancelAnimationFrame(frame); if (counters.get(feed) === add) counters.delete(feed); };
  }, [feed, add]);
  useEffect(() => {
    if (!feed) return;
    const reached = () => { if (atEnd(feed)) setBelow([]); };
    feed.addEventListener('scroll', reached, { passive: true });
    return () => feed.removeEventListener('scroll', reached);
  }, [feed]);
  const toEnd = useCallback(() => {
    const el = node.current;
    if (!el) return;
    endOpening(el);
    // A surface that follows the end is told the reader asked for it: what comes after is theirs to see, whatever the layout does first.
    told.current?.();
    // The line goes with the press: a person who used it from the keyboard keeps their place in the page, on the newest message.
    const fromLine = !!document.activeElement?.closest('.convo-newbelow');
    el.scrollTop = el.scrollHeight;
    setBelow([]);
    if (fromLine) newest(el)?.focus({ preventScroll: true });
  }, []);
  useEndKey(feed, count > 0, toEnd);
  return { count, add, toEnd };
}

/**
 * The feed's own composer: the first one met climbing from the feed, so a thread's beside the stream is never the stream's. A conversation
 * opens with the cursor in it (F-026 §4), so it is where a reader is when they press End first.
 */
function ownComposer(feed: HTMLElement): HTMLTextAreaElement | null {
  for (let node = feed.parentElement; node && node !== document.body; node = node.parentElement) {
    const field = node.querySelector<HTMLTextAreaElement>('.composer__box textarea');
    if (field) return field;
  }
  return null;
}

/**
 * End goes to the end of the feed while the "N new" line is showing: for a person who reads with the keyboard. That includes the feed's own
 * composer while it is empty, where a conversation opens and where End has nothing to move (personas-36: End did nothing right after
 * opening a long unread conversation); with words in it, End is the field's own. Typing in another field, a dialog, another view and a feed
 * that is not on screen keep their own End.
 */
function useEndKey(feed: HTMLElement | null, active: boolean, toEnd: () => void) {
  const latest = useRef(toEnd);
  useEffect(() => { latest.current = toEnd; });
  useEffect(() => {
    if (!feed || !active) return;
    const press = (event: KeyboardEvent) => {
      if (event.key !== 'End' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const composer = target instanceof HTMLTextAreaElement && !target.value && target === ownComposer(feed);
      if (!composer && isTyping(target)) return;
      // Only the surface the person is in: focus inside it or in its empty composer, or nowhere in particular (the page itself).
      const surface = feed.parentElement ?? feed;
      const nowhere = !target || target === document.body || target === document.documentElement;
      if (!nowhere && !composer && !surface.contains(target)) return;
      if (!feed.getClientRects().length || getComputedStyle(feed).visibility === 'hidden' || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [feed, active]);
}
