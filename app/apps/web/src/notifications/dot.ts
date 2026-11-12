import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED } from './api';
import { getNeedsYou } from './needsYou';

/**
 * How many things wait for you, for the sidebar's count and the phone's Inbox tab (F-026 §4, #342): the Inbox is the one place
 * that counts them (#865). Notifications are written by the worker shortly after the event, so a stream event refreshes it after a
 * short pause; it also refreshes on focus, when the inbox changes and every two minutes.
 */
export function useInboxDot(identity: string, pathname: string): { count: number; notifying: number } {
  const [unread, setUnread] = useState<{ identity: string; count: number; notifying: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const read = useCallback((fresh: boolean) => {
    void getNeedsYou(undefined, fresh).then((queue) => setUnread({ identity, count: queue.count, notifying: queue.notifying ?? 0 }), () => undefined);
  }, [identity]);
  // A refresh (focus, an event, a change of the Inbox, the two-minute poll) reads; a new page shares one read with its own queue (#862).
  const refresh = useCallback(() => read(true), [read]);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 1500);
  }, [refresh]);

  useEffect(() => { read(false); }, [read, identity, pathname]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener(INBOX_CHANGED, refresh);
    window.addEventListener('focus', onFocus);
    // Also while the live stream is open (#862): an item handled on another device, an item back from Later and a notification written late
    // send this tab no event. Half a request a minute.
    const interval = setInterval(refresh, 120_000);
    return () => {
      window.removeEventListener(INBOX_CHANGED, refresh);
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);
  // Someone seeing a message changes nothing that waits for this person (#862).
  useStreamEvents(identity, (event) => { if (!event.kind.endsWith('observed.v1')) soon(); }, refresh);
  return unread?.identity === identity ? { count: unread.count, notifying: unread.notifying } : { count: 0, notifying: 0 };
}
