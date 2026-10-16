import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NEEDS_YOU_PATH,
  needsYouItemPath,
  type NeedsYouItem,
  type NeedsYouResolved,
  type NeedsYouResponse,
  type ResolveNeedsYouCommand,
} from '@flux/contracts';
import { request } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED, announceInboxChange } from './api';
import { acceptingIds } from './pendingAccept';

/** The Inbox "Needs you" queue (#342): what asks something of you, computed for you alone. */
export const getNeedsYou = (signal?: AbortSignal) => request<NeedsYouResponse>(NEEDS_YOU_PATH, { signal });
export const resolveNeedsYou = (key: string, command: ResolveNeedsYouCommand) =>
  request<NeedsYouResolved>(needsYouItemPath(key), { method: 'POST', body: command });
/** Undo of `resolveNeedsYou`: the item is back as it was. */
export const restoreNeedsYou = (key: string) => request<void>(needsYouItemPath(key), { method: 'DELETE' });

export interface Queue {
  /** Null until the first answer; the last good answer stays while a later read fails. */
  items: NeedsYouItem[] | null;
  count: number;
  later: number;
  doneToday: number;
  failed: boolean;
  reload: () => void;
  /**
   * Removes an item at once (it was handled here). `settled`, when given, is the server write for it: until that
   * settles (success or failure), reads are not applied, and the queue is read again once nothing is pending.
   */
  hide: (key: string, settled?: Promise<unknown>) => void;
  /**
   * Puts an item back at its place without waiting for the next read (Undo). `settled` is the server write Undo
   * sends, if any; the same rule as for `hide` applies until it settles.
   */
  show: (item: NeedsYouItem, settled?: Promise<unknown>) => void;
}

const sorted = (items: NeedsYouItem[]) => {
  const order = { decision: 0, question: 1, blocked: 2, mention: 3 } as const;
  return [...items].sort((a, b) => order[a.kind] - order[b.kind] || b.at.localeCompare(a.at));
};

/**
 * The queue for Inbox and Home: read on mount, when the tab becomes visible, on stream events and when
 * something else changed the Inbox, so both places agree. Nothing is kept between accounts.
 */
export function useNeedsYou(userId: string): Queue {
  const [state, setState] = useState<{ userId: string; response: NeedsYouResponse | null; failed: boolean }>({ userId, response: null, failed: false });
  const [version, setVersion] = useState(0);
  // Showing an item again re-renders even when the answer already holds it (it was only filtered out).
  const [, redraw] = useState(0);
  // Counts local hide and show. A read that started before the latest one may predate its server write (#519).
  const localChanges = useRef(0);
  // Local changes whose server write has not settled. A read started meanwhile may still show what they removed.
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 1200);
  }, [reload]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Each local change is pending until its write has answered, success or failure; then the queue is read again.
  const track = useCallback((settled: Promise<unknown>) => {
    pending.current += 1;
    const end = () => {
      pending.current -= 1;
      if (pending.current === 0) soon();
    };
    settled.then(end, end);
  }, [soon]);

  useEffect(() => {
    const controller = new AbortController();
    const started = localChanges.current;
    const busy = pending.current > 0;
    getNeedsYou(controller.signal).then((response) => {
      // The answer may lack what this person just Undid, or still hold what they just handled (#519). It is not
      // applied; the local state stands, and the queue is read again once no local change is pending.
      if (busy || started !== localChanges.current) {
        if (pending.current === 0) soon();
        return;
      }
      setState({ userId, response, failed: false });
    }, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState((previous) => ({ userId, response: previous.userId === userId ? previous.response : null, failed: true }));
    });
    return () => controller.abort();
  }, [userId, version, soon]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', reload);
    window.addEventListener(INBOX_CHANGED, reload);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', reload);
      window.removeEventListener(INBOX_CHANGED, reload);
    };
  }, [reload]);
  useStreamEvents(userId, soon, reload);

  const mine = state.userId === userId ? state : { userId, response: null, failed: false };
  const hide = useCallback((key: string, settled?: Promise<unknown>) => { localChanges.current += 1; if (settled) track(settled); setState((previous) => previous.response
    ? { ...previous, response: { ...previous.response, items: previous.response.items.filter((item) => item.key !== key), count: Math.max(0, previous.response.count - 1) } } : previous); }, [track]);
  const show = useCallback((item: NeedsYouItem, settled?: Promise<unknown>) => { localChanges.current += 1; if (settled) track(settled); redraw((n) => n + 1); setState((previous) => previous.response && !previous.response.items.some((entry) => entry.key === item.key)
    ? { ...previous, response: { ...previous.response, items: sorted([...previous.response.items, item]), count: previous.response.count + 1 } } : previous); }, [track]);
  // A decision this person just accepted is not shown while the accept is waiting or on its way.
  const accepting = acceptingIds();
  const items = mine.response ? mine.response.items.filter((item) => !(item.decision && accepting.has(item.decision.id))) : null;
  return { items, count: items?.length ?? 0, later: mine.response?.later ?? 0, doneToday: mine.response?.doneToday ?? 0, failed: mine.failed, reload, hide, show };
}

export { announceInboxChange };
