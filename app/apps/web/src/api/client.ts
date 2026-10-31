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
}

/** The `ApiError` of a failed response, read from its JSON error body when it has one. */
export function responseError(response: Response, data: unknown): ApiError {
  const record = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown; error?: unknown };
  const code = typeof record.code === 'string' ? record.code : null;
  const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : response.statusText;
  // F-029 (#614): the workspace's AI was turned off since the shell last read it; the shell reads it again.
  if (response.status === 403 && code === 'WORKSPACE_AI_BLOCKED' && typeof window !== 'undefined') window.dispatchEvent(new Event('flux:workspace-ai-blocked'));
  return new ApiError(response.status, code, message, data);
}

/** A JSON request: the parsed body of a 2xx answer, or an `ApiError`. */
export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const response = await send(path, { ...init, accept: 'application/json', batchRead: true });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) throw responseError(response, data);
  return data as T;
}
