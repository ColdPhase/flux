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
}

export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  // A page being left starts no request (#471): the browser has stopped its loads, and WebKit reports a
  // fetch that starts now as an uncaught page error. It starts when the page is live again, never sooner
  // than a click or key press proves the person is still here; an unloaded page never starts it.
  if (pageLeaving() && !init.keepalive) await pageIsLive(init.signal);
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      keepalive: init.keepalive,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError();
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    const record = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown; error?: unknown };
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : response.statusText;
    // F-029 (#614): the workspace's AI was turned off since the shell last read it; the shell reads it again.
    if (response.status === 403 && code === 'WORKSPACE_AI_BLOCKED' && typeof window !== 'undefined') window.dispatchEvent(new Event('flux:workspace-ai-blocked'));
    throw new ApiError(response.status, code, message, data);
  }
  return data as T;
}
