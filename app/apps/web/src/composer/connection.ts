import { useSyncExternalStore } from 'react';

/**
 * Whether sends can reach Flux now (#264, HIG-67): the browser's own offline state, plus a send or
 * upload that failed to reach the server while the browser said it was online. The second clears
 * on the next answer from Flux: a delivered send, or a light check of `GET /api/v1/me` that runs
 * only while Flux is unreachable (every 3 s, slowing to 30 s). Any HTTP answer, even an error,
 * means Flux is reachable again.
 */
export type ConnectionState = 'online' | 'offline' | 'unreachable';

const listeners = new Set<() => void>();
const changes = new Set<() => void>();
let browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
let unreachable = false;
let probeTimer = 0;
let probeDelay = 3000;

export const connectionState = (): ConnectionState => browserOffline ? 'offline' : unreachable ? 'unreachable' : 'online';

function changed(before: ConnectionState) {
  const now = connectionState();
  if (now === before) return;
  listeners.forEach((listener) => listener());
  changes.forEach((listener) => listener());
}

function probe() {
  probeTimer = 0;
  if (!unreachable || browserOffline) return;
  void fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(() => {
      // Flux answers. Waiting sends go now; if they still get no answer, the next check waits longer.
      probeDelay = Math.min(30000, probeDelay * 2);
      clear();
    })
    .catch(() => {
      probeDelay = Math.min(30000, probeDelay * 2);
      scheduleProbe();
    });
}
function scheduleProbe() {
  if (probeTimer || !unreachable || browserOffline || typeof window === 'undefined') return;
  probeTimer = window.setTimeout(probe, probeDelay);
}

/** A send or upload got no answer at all (NetworkError). */
export function reportUnreachable() {
  const before = connectionState();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) browserOffline = true;
  else unreachable = true;
  scheduleProbe();
  changed(before);
}

function clear() {
  if (!unreachable) return;
  const before = connectionState();
  unreachable = false;
  if (probeTimer) { window.clearTimeout(probeTimer); probeTimer = 0; }
  changed(before);
}

/** Flux answered a send or an upload. */
export function reportReachable() {
  probeDelay = 3000;
  clear();
}

/** The person asked to try again now: their attempt is the check. */
export function assumeReachable() {
  clear();
}

/** Called on each change, including when sending becomes possible again. */
export function onConnectionChange(listener: () => void) {
  changes.add(listener);
  return () => { changes.delete(listener); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => { const before = connectionState(); browserOffline = true; changed(before); });
  window.addEventListener('online', () => {
    const before = connectionState();
    browserOffline = false;
    // Online again: check Flux now rather than after the remaining backoff.
    if (unreachable) { if (probeTimer) window.clearTimeout(probeTimer); probeTimer = 0; probeDelay = 3000; probe(); }
    changed(before);
  });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribe, connectionState, () => 'online');
}
