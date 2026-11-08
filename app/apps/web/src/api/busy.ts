/**
 * "Flux is busy" (#838, review of #1008): the API answered 429 with Retry-After to a read, the client waits that long and asks again,
 * and for that time the page says so (app/BusyNotice.tsx) and the sockets hold their reconnects. The limit is a floor against a runaway
 * client; a person never meets it, and one who does should see a calm wait, not the error page.
 */
let until = 0;
let waiting = 0;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/** Reads that get a 429 are asked again this many times before the answer is given as it is. */
export const BUSY_RETRIES = 3;
/** The longest a single wait is: the API's windows last a minute. */
export const BUSY_LONGEST_MS = 60_000;

/** The wait the API asked for, in ms: its `Retry-After` seconds (1 to 60), a few hundred ms of jitter so people do not return together. */
export function busyWaitMs(response: Pick<Response, 'headers'>, random: () => number = Math.random): number {
  const seconds = Number(response.headers.get('retry-after'));
  const asked = Number.isFinite(seconds) && seconds >= 1 ? Math.min(60, Math.ceil(seconds)) : 2;
  return asked * 1000 + Math.floor(random() * 750);
}

/** Waits `ms` while the page shows the wait; rejects with an AbortError if `signal` aborts first. */
export function waitOutBusy(ms: number, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + Math.min(ms, BUSY_LONGEST_MS);
  waiting += 1;
  until = Math.max(until, end);
  changed();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      waiting -= 1;
      if (!waiting) until = 0;
      changed();
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); finish(); resolve(); }, end - Date.now());
    const abort = () => { clearTimeout(timer); finish(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Milliseconds a wait for the API still has to run; 0 when none does. */
export function busyRemainingMs(now: number = Date.now()): number {
  return until > now ? until - now : 0;
}

/** A socket's wait before it reconnects: its own backoff, or the rest of the API's wait when that is longer. */
export function reconnectDelay(base: number): number {
  return Math.max(base, busyRemainingMs());
}

export function subscribeBusy(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** When the current wait ends (ms since the epoch), or 0. Stable between changes, for useSyncExternalStore. */
export function busyUntil(): number {
  return until;
}
