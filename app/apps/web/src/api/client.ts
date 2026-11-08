import { BUSY_RETRIES, busyWaitMs, waitOutBusy } from './busy.js';
import { pageIsLive, pageLeaving } from './pageLeaving.js';

/** Same-origin JSON requests. Session cookies are HttpOnly; the browser sends them itself. */
export class ApiError extends Error {
  /** `body` is the parsed error body, e.g. the latest version in a 409 VERSION_CONFLICT. */
  constructor(readonly status: number, readonly code: string | null, message: string, readonly body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server could not be reached at all (offline, DNS, server down). */
export class NetworkError extends Error {
  constructor() {
    super('Flux could not be reached');
    this.name = 'NetworkError';
  }
}

export interface ApiRequestInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers such as If-Match or Idempotency-Key. */
  headers?: Record<string, string>;
  /** Lets the request finish after the page is left (a delayed command sent on the way out). */
  keepalive?: boolean;
  /** The browser cache mode, e.g. `no-store` for a file or a reachability check that must not be served from cache. */
  cache?: RequestCache;
}

// A read starts in a task of its own, after the work that asked for it (#716). A view opening asks for half a dozen reads from
// its effects; each `fetch` call costs milliseconds on the main thread of a phone, and made in the commit's own task they
// were a third of the longest frame of a view change. One port message batches every read asked for in the same task.
const later = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
const waiting: (() => void)[] = [];
if (later) {
  later.port1.onmessage = () => { for (const start of waiting.splice(0)) start(); };
  // Outside a browser (Node runs the client in tests and tools) a port with a listener keeps the process alive; a
  // scheduler must not, so it is unreferenced where that exists (#752). Browsers have no such thing.
  (later.port1 as MessagePort & { unref?: () => void }).unref?.();
}
const nextTask = () => new Promise<void>((resolve) => {
  if (!later) { setTimeout(resolve, 0); return; }
  if (!waiting.length) later.port2.postMessage(0);
  waiting.push(resolve);
});

/**
 * The one transport to the Flux API (#93): every call of the web app, JSON or not, goes through here.
 * Answers the raw response of any status; only a request that got no answer throws (`NetworkError`, or the
 * caller's `AbortError`). `accept` is sent only when given, so a file read keeps the browser's default;
 * `batchRead` starts a GET in the next task with the other reads of this one (#716), as every JSON read does.
 */
export async function send(path: string, init: ApiRequestInit & { accept?: string; batchRead?: boolean } = {}): Promise<Response> {
  // A read starts in a task of its own (#716), so the page is checked after that wait, in the same breath as `fetch`: a
  // navigation can begin in the task between, and a read asked for just before it, with the gate checked first, started
  // after `beforeunload` (#758, #759: working-agents, needs-you and the other shell reads of a page that is left).
  if (init.batchRead && (!init.method || init.method === 'GET')) await nextTask();
  const attempt = async (): Promise<Response> => {
    // A page being left starts no request (#471): the browser has stopped its loads, and WebKit reports a
    // fetch that starts now as an uncaught page error. It starts when the page is live again, never sooner
    // than a click or key press proves the person is still here; an unloaded page never starts it.
    if (pageLeaving() && !init.keepalive) await pageIsLive(init.signal);
    try {
      return await fetch(path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        headers: { ...(init.accept ? { accept: init.accept } : {}), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
        keepalive: init.keepalive,
        cache: init.cache,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError();
    }
  };
  let response = await attempt();
  // The API is busy (429 with Retry-After, the floor of rate limits): a read is asked again after the wait, with the page saying so
  // (#838). Only a read: a write could have been done, and the person decides whether to send it again.
  const read = (!init.method || init.method === 'GET' || init.method === 'HEAD') && init.body === undefined && !init.keepalive;
  for (let tries = 0; response.status === 429 && read && tries < BUSY_RETRIES; tries += 1) {
    await waitOutBusy(busyWaitMs(response), init.signal);
    response = await attempt();
  }
  return response;
}

/** The `ApiError` of a failed response, read from its JSON error body when it has one. */
export function responseError(response: Pick<Response, 'status' | 'statusText'>, data: unknown): ApiError {
  const record = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown; error?: unknown };
  const code = typeof record.code === 'string' ? record.code : null;
  const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : response.statusText;
  // AG-10: the space's AI was turned off since the shell last read it; the shell reads it again.
  if (response.status === 403 && code === 'SPACE_AI_OFF' && typeof window !== 'undefined') window.dispatchEvent(new Event('flux:space-ai-off'));
  // F-030 (#655): the workspace is an encrypted one that waits to be unlocked; the shell reads the workspaces again and the page turns into the locked panel.
  if (response.status === 423 && code === 'WORKSPACE_LOCKED' && typeof window !== 'undefined') {
    const details = (data as { details?: { workspaceId?: unknown } } | null)?.details;
    window.dispatchEvent(new CustomEvent('flux:workspace-locked', { detail: { workspaceId: typeof details?.workspaceId === 'string' ? details.workspaceId : null } }));
  }
  return new ApiError(response.status, code, message, data);
}

interface Answer { ok: boolean; status: number; statusText: string; text: string }

async function read(path: string, init: ApiRequestInit): Promise<Answer> {
  const response = await send(path, { ...init, accept: 'application/json', batchRead: true });
  return { ok: response.ok, status: response.status, statusText: response.statusText, text: await response.text() };
}

/**
 * Plain reads of the same address that are in flight together share one request (#850, #862: a navigation asked for the same project
 * and people up to four times, from its route loaders and its components). Only what is in flight is shared, never an answer that has
 * already arrived, so nothing is served stale; each caller parses its own copy of the text, and aborting stops the request only
 * when every caller that wanted it has aborted.
 */
interface SharedRead { answer: Promise<Answer>; callers: number; abort: AbortController }
const inFlight = new Map<string, SharedRead>();

function startSharedRead(path: string): SharedRead {
  const abort = new AbortController();
  const created: SharedRead = { answer: read(path, { signal: abort.signal }), callers: 0, abort };
  const finish = () => { if (inFlight.get(path) === created) inFlight.delete(path); };
  created.answer.then(finish, finish);
  inFlight.set(path, created);
  return created;
}

function sharedRead(path: string, signal: AbortSignal | undefined): Promise<Answer> {
  const entry = inFlight.get(path) ?? startSharedRead(path);
  entry.callers += 1;
  return new Promise<Answer>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      signal?.removeEventListener('abort', onAbort);
      entry.callers -= 1;
      if (entry.callers === 0) { if (inFlight.get(path) === entry) inFlight.delete(path); entry.abort.abort(); }
    };
    const onAbort = () => { leave(); reject(new DOMException('The operation was aborted.', 'AbortError')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.answer.then((answer) => { if (!left) { left = true; signal?.removeEventListener('abort', onAbort); entry.callers -= 1; resolve(answer); } },
      (error: unknown) => { if (!left) { left = true; signal?.removeEventListener('abort', onAbort); entry.callers -= 1; reject(error); } });
  });
}

/** A JSON request: the parsed body of a 2xx answer, or an `ApiError`. */
export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const plainRead = (!init.method || init.method === 'GET') && !init.headers && !init.keepalive && init.cache === undefined;
  const response = plainRead ? await sharedRead(path, init.signal) : await read(path, init);
  let data: unknown = null;
  if (response.text) {
    try { data = JSON.parse(response.text); } catch { data = null; }
  }
  if (!response.ok) throw responseError(response, data);
  return data as T;
}
