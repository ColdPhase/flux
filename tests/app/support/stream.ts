import WebSocket from 'ws';
import type { StreamEvent, StreamMessage, StreamReady } from '@flux/contracts';
import { apiUrl, publicOrigin, type Browser } from './http.js';

export interface StreamOptions {
  cursor?: string | number;
  /** Origin header; null omits it. Defaults to the public origin. */
  origin?: string | null;
}

function streamUrl(cursor?: string | number) {
  const url = new URL('/api/v1/stream', apiUrl.replace(/^http/, 'ws'));
  if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));
  return url;
}

function open(browser: Browser | null, options: StreamOptions) {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? publicOrigin : options.origin;
  if (origin !== null) headers.origin = origin;
  if (browser?.cookies.size) headers.cookie = browser.cookieHeader();
  return new WebSocket(streamUrl(options.cursor), { headers });
}

/** A WebSocket subscriber that records every message, ping and the close frame. */
export class StreamClient {
  readonly messages: StreamMessage[] = [];
  pings = 0;
  closeCode: number | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as StreamMessage);
      this.notify();
    });
    socket.on('ping', () => { this.pings += 1; this.notify(); });
    this.closed = new Promise((resolve) => socket.on('close', (code, reason) => {
      this.closeCode = code;
      this.notify();
      resolve({ code, reason: String(reason) });
    }));
  }

  static connect(browser: Browser, options: StreamOptions = {}): Promise<StreamClient> {
    const socket = open(browser, options);
    const client = new StreamClient(socket);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(client));
      socket.once('unexpected-response', (_request, response) => reject(new Error(`Upgrade rejected with ${response.statusCode}`)));
      socket.once('error', reject);
    });
  }

  get events(): StreamEvent[] {
    return this.messages.filter((message): message is StreamEvent => message.type === 'event');
  }

  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves when `check` returns a value; rejects after `timeoutMs`. */
  async until<T>(check: () => T | undefined | null | false, timeoutMs = 8000, label = 'condition'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${label}; received ${JSON.stringify(this.messages.map((m) => m.type === 'event' ? `${m.kind}:${m.objectId}` : m))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  ready(timeoutMs?: number): Promise<StreamReady> {
    return this.until(() => this.messages.find((m): m is StreamReady => m.type === 'ready'), timeoutMs, 'ready');
  }

  event(objectId: string, kind?: string, timeoutMs?: number): Promise<StreamEvent> {
    return this.until(() => this.events.find((e) => e.objectId === objectId && (!kind || e.kind === kind)), timeoutMs, `${kind ?? 'event'} for ${objectId}`);
  }

  async close() {
    if (this.closeCode === null) this.socket.close(1000);
    await this.closed;
  }
}

/** HTTP status of the upgrade: 101 when accepted (the socket is closed again), otherwise the rejection status. */
export function upgradeStatus(browser: Browser | null, options: StreamOptions = {}): Promise<number> {
  const socket = open(browser, options);
  return new Promise((resolve, reject) => {
    socket.once('open', () => { socket.close(1000); resolve(101); });
    socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); socket.terminate(); });
    socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error); });
  });
}
