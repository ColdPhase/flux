import { useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '../ui';
import { busyUntil, subscribeBusy } from '../api/busy';
import './route-progress.css';

/**
 * The API said "busy" (429, the floor of rate limits, #838) and a read is waiting out its Retry-After: one calm line, over the top of the
 * work like the route progress row, that counts down. Nothing moves, nothing is lost, and the page asks again by itself.
 */
export function BusyNotice() {
  const until = useSyncExternalStore(subscribeBusy, busyUntil, () => 0);
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
  return <div className="route-progress busy-notice" data-busy-notice="">
    <span role="status" aria-live="polite"><Spinner />Flux is busy. Trying again in {seconds} {seconds === 1 ? 'second' : 'seconds'}.</span>
  </div>;
}
