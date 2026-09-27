/** Same-origin JSON requests. Session cookies are HttpOnly; the browser sends them itself. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
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

export async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
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
    throw new ApiError(response.status, code, message);
  }
  return data as T;
}
