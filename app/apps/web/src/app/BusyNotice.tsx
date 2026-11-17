import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '../ui';
import { publishTopEdge } from '../ui/edgeInset';
import { busyUntil, subscribeBusy } from '../api/busy';
import { useConnection, useConnectionLineShown } from '../composer/connection';
import './route-progress.css';

/**
 * The busy and offline lines publish their top edge (`--ui-notice-inset`), so a toast shown with them stands above them, never on them.
 */
function useNoticeEdge() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => (node ? publishTopEdge(node, '--ui-notice-inset') : undefined), [node]);
  return useCallback((element: HTMLDivElement | null) => setNode(element), []);
}

/**
 * The API said "busy" (429, the floor of rate limits, #838) and a read is waiting out its Retry-After: one calm line, over the top of the
 * work like the route progress row, that counts down. Nothing moves, nothing is lost, and the page asks again by itself.
 */
export function BusyNotice() {
  const until = useSyncExternalStore(subscribeBusy, busyUntil, () => 0);
  const edge = useNoticeEdge();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [until]);
  if (!until) return null;
  const seconds = Math.max(1, Math.ceil((until - now) / 1000));
  return <div ref={edge} className="route-progress busy-notice" data-busy-notice="">
    <span role="status" aria-live="polite"><Spinner />Flux is busy. Trying again in {seconds} {seconds === 1 ? 'second' : 'seconds'}.</span>
  </div>;
}

/**
 * Offline, on a page with no composer (Home, the Inbox, My tasks, Search, Settings): one calm line in the busy line's place says so, so a
 * page that could not read never looks empty or wrong without a reason (round 14, look-a A7). Back online, the pages read again by
 * themselves. Where a composer shows its own connection line, that line says it, once.
 */
export function OfflineNotice() {
  const state = useConnection();
  const lineShown = useConnectionLineShown();
  const edge = useNoticeEdge();
  if (state !== 'offline' || lineShown) return null;
  return <div ref={edge} className="route-progress busy-notice" data-offline-notice="">
    <span role="status" aria-live="polite">You’re offline. Flux shows what it last loaded and catches up when you’re back.</span>
  </div>;
}
