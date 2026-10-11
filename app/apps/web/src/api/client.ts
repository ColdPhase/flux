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
}

/** A navigation cancelled after `beforeunload` never reaches `pagehide`; requests resume after this. */
const LEAVING_GRACE_MS = 1000;
/**
 * True while the page is being left. A request started then is cancelled by the navigation, and
 * WebKit reports that cancellation as a page error ("access control checks", #471), so it is not
 * sent: nothing can use its answer. `pageshow` clears the flag, which also covers a page restored
 * from the back-forward cache.
 */
let leaving = false;
let hidden = false;
let graceTimer = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    leaving = true;
    window.clearTimeout(graceTimer);
    graceTimer = window.setTimeout(() => { if (!hidden) leaving = false; }, LEAVING_GRACE_MS);
  });
  window.addEventListener('pagehide', () => { hidden = true; leaving = true; });
  window.addEventListener('pageshow', () => { hidden = false; leaving = false; window.clearTimeout(graceTimer); });
}

export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  if (leaving) throw new DOMException('The page is being left.', 'AbortError');
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
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
    throw new ApiError(response.status, code, message, data);
  }
  return data as T;
}
