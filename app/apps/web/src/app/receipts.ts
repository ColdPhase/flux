import { useEffect, useRef, useState, type RefObject } from 'react';
import { RECEIPT_LIMITS, type MessageReadersResult, type MessageReader, type MessageReceiptsResult, type ObserveMessagesResult } from '@flux/contracts';
import { sameMessageAuthor } from './messageParts';
import { streamLive, useStreamEvents } from '../api/stream';

/**
 * Viewing receipts for a private conversation (#534). What counts as "observed": a message written by someone else
 * that stays at least 60% of its height (or 60% of the reading area, for a tall one) inside the reading area for
 * `DWELL_MS`, while the page is visible and focused. Offscreen messages, a hidden or unfocused tab, a send, a
 * return point or reading only the last message of a run never count. The server checks every id against the
 * conversation and the person's current access; this hook only decides when to ask.
 */
export const DWELL_MS = 700;
const FLUSH_MS = 400;
const SEEN_RATIO = 0.6;

const watching = () => document.visibilityState === 'visible' && document.hasFocus();

export function useObservation({ scope, observe, enabled, feed, ids: watched, depend }: {
  /** The conversation the writes belong to; what was written is remembered per scope. */
  scope: string; observe: (ids: string[]) => Promise<ObserveMessagesResult>; enabled: boolean; feed: RefObject<HTMLElement | null>;
  /** The ids of other people's messages on screen: only those are watched. Each element carries `data-observe-id`. */
  ids: readonly string[]; depend?: unknown;
}) {
  const sent = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const flushing = useRef(false);
  const flushTimer = useRef(0);

  const ids = watched.join(',');
  useEffect(() => {
    const root = feed.current;
    if (!enabled || !root || !ids) return;
    const flush = async () => {
      if (flushing.current || !queue.current.size) return;
      flushing.current = true;
      const batch = [...queue.current].slice(0, RECEIPT_LIMITS.messagesPerCall);
      batch.forEach((id) => queue.current.delete(id));
      try { await observe(batch); batch.forEach((id) => sent.current.add(id)); }
      catch { /* A failed write is retried the next time the message is observed: nothing is claimed meanwhile. */ }
      finally {
        flushing.current = false;
        if (queue.current.size) flushTimer.current = window.setTimeout(() => void flush(), FLUSH_MS);
      }
    };
    const timers = new Map<Element, number>();
    const unseen = () => [...root.querySelectorAll<HTMLElement>('[data-observe-id]')].filter((element) => !sent.current.has(element.dataset.observeId ?? ''));
    const settle = (element: Element) => {
      const id = (element as HTMLElement).dataset.observeId;
      timers.delete(element);
      if (!id || sent.current.has(id) || !watching()) return;
      queue.current.add(id);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    };
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const area = entry.rootBounds?.height ?? 0;
        const enough = entry.isIntersecting && (entry.intersectionRatio >= SEEN_RATIO || (area > 0 && entry.intersectionRect.height >= area * SEEN_RATIO));
        const pending = timers.get(entry.target);
        if (enough && pending === undefined) timers.set(entry.target, window.setTimeout(() => settle(entry.target), DWELL_MS));
        else if (!enough && pending !== undefined) { window.clearTimeout(pending); timers.delete(entry.target); }
      }
    }, { root, threshold: [0, 0.25, SEEN_RATIO, 1] });
    unseen().forEach((element) => io.observe(element));
    // Coming back to the tab restarts the clock of whatever is still in view.
    const back = () => {
      if (!watching()) return;
      timers.forEach((timer) => window.clearTimeout(timer)); timers.clear();
      io.disconnect(); unseen().forEach((element) => io.observe(element));
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      io.disconnect(); timers.forEach((timer) => window.clearTimeout(timer));
      document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back);
    };
  }, [scope, enabled, feed, ids, depend]);
  useEffect(() => () => window.clearTimeout(flushTimer.current), []);
}

/** A run of the person's own consecutive messages that is whole: every message of it is on screen and stored. */
export interface OwnRun { ids: string[]; last: string }

type Line = { id: string | null; authorId: string; createdAt: string };

/**
 * The person's own author runs, as the bubbles group them (same author, same day). A run is left out when it
 * could be longer than what is loaded: it starts at the first loaded message while earlier ones exist, or it is
 * followed by a message still being sent. Only whole runs can claim "Seen by".
 */
export function ownRuns(lines: readonly Line[], meId: string, hasEarlier: boolean): OwnRun[] {
  const runs: OwnRun[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    while (end + 1 < lines.length && sameMessageAuthor(lines[end], lines[end + 1])) end++;
    const run = lines.slice(start, end + 1);
    const whole = run.every((line) => line.id !== null) && !(hasEarlier && start === 0);
    if (run[0]!.authorId === meId && whole) runs.push({ ids: run.map((line) => line.id!), last: run.at(-1)!.id! });
    start = end + 1;
  }
  return runs;
}

/**
 * Who read one of the person's own whole runs (#1231): how many, and only the newest few, which is all the row under the message draws.
 * `list` reads the whole list a page at a time, and is called only when a person opens it.
 */
export interface Receipt {
  count: number;
  readers: readonly MessageReader[];
  list: (after: string | undefined, signal: AbortSignal) => Promise<MessageReadersResult>;
}

/**
 * Who read each of the person's own whole runs, keyed by the run's last message. Each reader is in one run, the newest they read whole
 * (the server places them); refetched when the runs or `tick` change. Only the newest runs are asked about: older ones are bounded by
 * the request limits and are not at the reading edge.
 */
export function useReceipts({ scope, fetchReceipts, fetchReaders, runs, tick }: {
  scope: string; fetchReceipts: (runs: string[][], signal: AbortSignal) => Promise<MessageReceiptsResult>;
  fetchReaders: (runs: string[][], run: number, after: string | undefined, signal: AbortSignal) => Promise<MessageReadersResult>;
  runs: readonly OwnRun[]; tick: number;
}) {
  const key = `${scope}|${runs.map((run) => run.ids.join('+')).join('|')}`;
  const [answer, setAnswer] = useState<{ key: string; seen: Map<string, Receipt> }>({ key: '', seen: new Map() });
  const readers = useRef(fetchReaders);
  useEffect(() => { readers.current = fetchReaders; });
  useEffect(() => {
    const wanted = runs.slice(-RECEIPT_LIMITS.runsPerCall).filter((run) => run.ids.length <= RECEIPT_LIMITS.messagesPerCall);
    if (!wanted.length) return;
    const lists = wanted.map((run) => run.ids);
    const controller = new AbortController();
    fetchReceipts(lists, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setAnswer({ key, seen: new Map(result.runs.map((run, index) => [wanted[index]!.last, {
        count: run.count, readers: run.readers, list: (after, signal) => readers.current(lists, index, after, signal),
      }])) });
    }).catch(() => { /* Without an answer nothing is claimed. */ });
    return () => controller.abort();
    // `key` stands for the runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, key, tick]);
  // An answer for other runs is never shown against these.
  return answer.key === key ? answer.seen : EMPTY;
}

const EMPTY = new Map<string, Receipt>();

/**
 * When a space's receipts are read again (#862): when someone sees the person's messages there for the first time, the server tells the
 * author (`project.messages_observed.v1`); a tick every few seconds is the fallback only while the live stream is down.
 */
export function useReceiptTick(enabled: boolean, identity: string, projectId: string, ms = 8000) {
  const [tick, setTick] = useState(0);
  const last = useRef(0);
  const later = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !streamLive()) setTick((value) => value + 1); }, ms);
    return () => window.clearInterval(timer);
  }, [enabled, ms]);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => setTick((value) => value + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);
  useEffect(() => () => window.clearTimeout(later.current), []);
  // Many people reading at once (a space of hundreds) send an event each: the first one asks at once, the rest of that window ask
  // once more at its end, so the receipts are read a few times a second at most and never once per reader (#1231).
  const poke = () => {
    const wait = last.current + EVENT_WINDOW_MS - Date.now();
    const ask = () => { later.current = 0; last.current = Date.now(); setTick((value) => value + 1); };
    if (wait <= 0) ask();
    else if (!later.current) later.current = window.setTimeout(ask, wait);
  };
  useStreamEvents(identity, (event) => {
    if (!enabled) return;
    // Someone saw the person's messages; or someone may no longer read the space, and "Seen by" names only those who can now.
    if ((event.kind === MESSAGES_OBSERVED || READERS_CHANGED.has(event.kind)) && event.objectId === projectId) poke();
    else if (event.objectType === 'workspace' && READERS_CHANGED.has(event.kind)) poke();
  }, () => { if (enabled) setTick((value) => value + 1); });
  return tick;
}

/** The most often the receipts are read again because of events: one read a window, however many people read in it. */
const EVENT_WINDOW_MS = 1500;

/** Changes that can take a reader out of a space: "Seen by" names only people who can read it now (#534, #862). */
const READERS_CHANGED = new Set(['project.grant_revoked.v1', 'project.grant_set.v1', 'project.access_ended.v1', 'project.deleted.v1',
  'workspace.member_removed.v1', 'workspace.member_role_changed.v1', 'workspace.access_ended.v1']);

/** Someone saw messages of a space for the first time; it reaches their authors only (#862). */
export const MESSAGES_OBSERVED = 'project.messages_observed.v1';
