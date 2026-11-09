/**
 * How often a page reads its shell: the person and the workspaces (#1126). Every navigation and every revalidation reads them. A page
 * that navigates or revalidates in a loop (something that asks again on each render) must not turn that into thousands of requests, and
 * reads that fail (the server or the network down) must not be retried in a tight loop:
 * - reads that did not finish (stopped by the next one, or failed) back off: after three in a row, each waits twice as long as the
 *   last, from a quarter of a second up to 30 s, and one that finishes ends the back-off;
 * - and whatever happens, at most SHELL_READS_PER_MINUTE start in any minute; the next waits for the oldest to be a minute old.
 * A person using Flux never meets either: a page reads its shell a few times a minute at the most.
 */
export const SHELL_READS_PER_MINUTE = 30;
const FREE_UNFINISHED = 3;
const MAX_WAIT_MS = 30_000;

const started: number[] = [];
let unfinished = 0;

function wait(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(new DOMException('The operation was aborted.', 'AbortError')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Reads the shell with `read`, paced as above. A read stopped while it waits never starts. */
export async function pacedShellRead<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  const now = Date.now();
  while (started.length && now - started[0]! >= 60_000) started.shift();
  let delay = unfinished >= FREE_UNFINISHED ? Math.min(MAX_WAIT_MS, 250 * 2 ** (unfinished - FREE_UNFINISHED)) : 0;
  if (started.length >= SHELL_READS_PER_MINUTE) delay = Math.max(delay, 60_000 - (now - started[0]!));
  if (delay > 0) await wait(delay, signal);
  started.push(Date.now());
  unfinished += 1;
  try {
    const result = await read();
    unfinished = 0;
    return result;
  } catch (error) {
    // A redirect (signed out) is an answer, not a failure.
    if (error instanceof Response) unfinished = 0;
    throw error;
  }
}

/** For tests: forget what was read. */
export function resetShellPace() {
  started.length = 0;
  unfinished = 0;
}
