import { useEffect, useRef, useState, type RefObject } from 'react';
import { RECEIPT_LIMITS, type DmMessage, type DmPerson } from '@flux/contracts';
import { dmReceipts, observeDmMessages } from '../api/direct-messages';
import { sameMessageAuthor } from '../app/messageParts';

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

export function useObservation({ dmId, meId, enabled, feed, messages, depend }: {
  dmId: string; meId: string; enabled: boolean; feed: RefObject<HTMLElement | null>;
  /** The messages on screen; only other people's are watched. */
  messages: readonly DmMessage[]; depend?: unknown;
}) {
  const sent = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const flushing = useRef(false);
  const flushTimer = useRef(0);

  const ids = messages.filter((m) => m.authorId !== meId).map((m) => m.id).join(',');
  useEffect(() => {
    const root = feed.current;
    if (!enabled || !root || !ids) return;
    const flush = async () => {
      if (flushing.current || !queue.current.size) return;
      flushing.current = true;
      const batch = [...queue.current].slice(0, RECEIPT_LIMITS.messagesPerCall);
      batch.forEach((id) => queue.current.delete(id));
      try { await observeDmMessages(dmId, batch); batch.forEach((id) => sent.current.add(id)); }
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
  }, [dmId, enabled, feed, ids, depend]);
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

/** Who observed every message of each of the person's own whole runs; refetched when the runs or `tick` change. */
export function useReceipts({ dmId, runs, tick }: { dmId: string; runs: readonly OwnRun[]; tick: number }) {
  const key = `${dmId}|${runs.map((run) => run.ids.join('+')).join('|')}`;
  const [answer, setAnswer] = useState<{ key: string; seen: Map<string, DmPerson[]> }>({ key: '', seen: new Map() });
  useEffect(() => {
    // The newest runs only: older ones are bounded by the request limits and are not at the reading edge.
    const wanted = runs.slice(-RECEIPT_LIMITS.runsPerCall).filter((run) => run.ids.length <= RECEIPT_LIMITS.messagesPerCall);
    if (!wanted.length) return;
    const controller = new AbortController();
    dmReceipts(dmId, wanted.map((run) => run.ids), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setAnswer({ key, seen: new Map(result.runs.map((run, index) => [wanted[index]!.last, run.seenBy])) });
    }).catch(() => { /* Without an answer nothing is claimed. */ });
    return () => controller.abort();
    // `key` stands for the runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId, key, tick]);
  // An answer for other runs is never shown against these.
  return answer.key === key ? answer.seen : EMPTY;
}

const EMPTY = new Map<string, DmPerson[]>();
