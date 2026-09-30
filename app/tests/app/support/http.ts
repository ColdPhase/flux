import { randomUUID } from 'node:crypto';

export const apiUrl = process.env.FLUX_API_URL ?? 'http://api:8080';
export const publicOrigin = process.env.FLUX_PUBLIC_ORIGIN ?? '';
export const mailpitUrl = process.env.FLUX_MAILPIT_URL ?? 'http://mailpit:8025';

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Origin header to send on the request; null omits it. Defaults to the public origin. */
  origin?: string | null;
}

export interface ClientResponse {
  status: number;
  headers: Headers;
  setCookies: string[];
  json: unknown;
  text: string;
}

/** A minimal cookie-jar client acting as one browser against the running API container. */
export class Browser {
  readonly cookies = new Map<string, string>();

  /** Defaults to the API container; in-process servers pass their own address and origin. */
  constructor(readonly base = apiUrl, readonly defaultOrigin = publicOrigin) {}

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<ClientResponse> {
    const headers: Record<string, string> = { ...options.headers };
    const origin = options.origin === undefined ? this.defaultOrigin : options.origin;
    if (origin !== null) headers.origin = origin;
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(path, this.base), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const [pair, ...attributes] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers: response.headers, setCookies, json, text };
  }
}

export function uniqueEmail(label: string) {
  return `${label}-${randomUUID()}@example.test`;
}

export async function register(email: string, password: string, name = 'Test Person') {
  const browser = new Browser();
  const response = await browser.request('POST', '/api/auth/sign-up/email', { body: { email, password, name } });
  if (response.status !== 200) throw new Error(`Sign-up failed with ${response.status}: ${response.text}`);
  return { browser, response };
}

export async function signIn(email: string, password: string, headers?: Record<string, string>) {
  const browser = new Browser();
  const response = await browser.request('POST', '/api/auth/sign-in/email', { body: { email, password }, headers });
  return { browser, response };
}

interface MailpitSearch {
  messages: { ID: string }[];
}

/** Waits for the newest message to a recipient in the mail catcher and returns its text body. */
export async function waitForMail(to: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const result = await search.json() as MailpitSearch;
    const latest = result.messages[0];
    if (latest) {
      const message = await fetch(`${mailpitUrl}/api/v1/message/${latest.ID}`);
      const body = await message.json() as { Text: string };
      return body.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No mail for ${to} within ${timeoutMs} ms`);
}

export async function mailCount(to: string): Promise<number> {
  const search = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const result = await search.json() as MailpitSearch;
  return result.messages.length;
}
