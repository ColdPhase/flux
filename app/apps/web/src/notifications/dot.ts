import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED } from './api';
import { getNeedsYou } from './needsYou';

/**
 * How many things need you, for the sidebar's count and the project header's pill (F-026 §4, #342). Notifications are written by the worker shortly after the event,
 * so a stream event refreshes it after a short pause; it also refreshes on focus, when the inbox
 * changes and every two minutes.
 */
export interface InboxCounts {
  /** Everything in "Needs you", for the sidebar and the phone's Inbox tab. */
  count: number;
  /** The same items by project, for the project header's "N needs you" (#763 A2): one queue, one count. */
  byProject: ReadonlyMap<string, number>;
}

const EMPTY: InboxCounts = { count: 0, byProject: new Map() };

export function useInboxDot(identity: string, pathname: string): InboxCounts {
  const [unread, setUnread] = useState<{ identity: string; counts: InboxCounts } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    void getNeedsYou().then((queue) => {
      const byProject = new Map<string, number>();
      for (const item of queue.items) if (item.project) byProject.set(item.project.id, (byProject.get(item.project.id) ?? 0) + 1);
      setUnread({ identity, counts: { count: queue.count, byProject } });
    }, () => undefined);
  }, [identity]);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 1500);
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh, identity, pathname]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener(INBOX_CHANGED, refresh);
    window.addEventListener('focus', onFocus);
    const interval = setInterval(refresh, 120_000);
    return () => {
      window.removeEventListener(INBOX_CHANGED, refresh);
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);
  useStreamEvents(identity, soon, refresh);
  return unread?.identity === identity ? unread.counts : EMPTY;
}
