import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED } from './api';
import { getNeedsYou } from './needsYou';

/**
 * How many things need you, for the sidebar's count (F-026 §4, #342). Notifications are written by the worker shortly after the event,
 * so a stream event refreshes it after a short pause; it also refreshes on focus, when the inbox
 * changes and every two minutes.
 */
export function useInboxDot(identity: string, pathname: string) {
  const [unread, setUnread] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    void getNeedsYou().then((queue) => setUnread(queue.count), () => undefined);
  }, []);
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
  return unread;
}
