import { TYPING_PATH, type TypingContext, type TypingSnapshot } from '@flux/contracts';

export interface TypingView { availability: 'ready' | 'unavailable'; people: { id: string; name: string }[] }
const EMPTY: TypingView = { availability: 'unavailable', people: [] };

/** Owns one ephemeral scope, never the composer value or durable event cursor. */
export class TypingClient {
  private socket: WebSocket | null = null;
  private epoch = 0;
  private started = false;
  private writable = false;
  private authenticated = false;
  private terminal = false;
  private pendingInput = false;
  private published = false;
  private lastActive = -Infinity;
  private inputTimer: number | null = null;
  private retryTimer: number | null = null;
  private freshnessTimer: number | null = null;
  private retry = 0;
  private view: TypingView = EMPTY;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly context: TypingContext | null, private readonly identity: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.view;
  private update(view: TypingView) {
    if (JSON.stringify(this.view) === JSON.stringify(view)) return;
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  setWritable(writable: boolean) { this.writable = writable; if (!writable) this.stop(); }
  start() {
    if (this.started || !this.context) return;
    this.started = true;
    window.addEventListener('blur', this.stop);
    window.addEventListener('pagehide', this.suspend);
    window.addEventListener('pageshow', this.resume);
    document.addEventListener('visibilitychange', this.visibility);
    this.connect();
  }
  close() {
    this.started = false;
    this.suspend();
    window.removeEventListener('blur', this.stop);
    window.removeEventListener('pagehide', this.suspend);
    window.removeEventListener('pageshow', this.resume);
    document.removeEventListener('visibilitychange', this.visibility);
  }
  /** Called only by a real input event. The parameter is a boolean, never draft text. */
  input(hasText: boolean) {
    if (!hasText || !this.writable || document.visibilityState !== 'visible') { this.stop(); return; }
    if (!this.authenticated || this.terminal || !this.socket || this.socket.readyState !== WebSocket.OPEN || this.view.availability !== 'ready') return;
    this.pendingInput = true;
    if (this.inputTimer !== null) return;
    const delay = Math.max(180, 1500 - (performance.now() - this.lastActive));
    const epoch = this.epoch;
    this.inputTimer = window.setTimeout(() => {
      this.inputTimer = null;
      if (epoch !== this.epoch || !this.pendingInput || !this.writable || document.visibilityState !== 'visible' || this.view.availability !== 'ready') return;
      this.pendingInput = false;
      if (this.send({ type: 'active', active: true })) { this.published = true; this.lastActive = performance.now(); }
      else this.transportFailed();
    }, delay);
  }
  stop = () => {
    this.pendingInput = false;
    if (this.inputTimer !== null) window.clearTimeout(this.inputTimer); this.inputTimer = null;
    if (this.published && !this.send({ type: 'active', active: false })) this.transportFailed();
    this.published = false;
  };
  private send(command: { type: 'active'; active: boolean } | { type: 'watch'; context: TypingContext }) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 1024) return false;
    try { this.socket.send(JSON.stringify(command)); return true; } catch { return false; }
  }
  private transportFailed() { this.update(EMPTY); this.socket?.close(1000); }
  private suspend = () => {
    this.stop(); this.epoch++; this.authenticated = false;
    this.clearFreshness();
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer); this.retryTimer = null;
    const socket = this.socket; this.socket = null; socket?.close(1000);
    this.update(EMPTY);
  };
  private resume = () => { if (this.started && document.visibilityState === 'visible') this.connect(); };
  private visibility = () => { if (document.visibilityState === 'hidden') this.suspend(); else this.resume(); };
  private connect() {
    if (!this.started || this.terminal || !this.context || this.socket || document.visibilityState !== 'visible') return;
    const url = new URL(TYPING_PATH, window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.socket = socket;
    const epoch = ++this.epoch;
    const current = () => this.started && this.socket === socket && this.epoch === epoch;
    socket.onopen = () => {
      if (current()) this.freshnessTimer = window.setTimeout(() => { if (current()) { this.suspend(); this.schedule(); } }, 3000);
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      let raw: TypingSnapshot;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > 65536) throw new Error('Invalid snapshot');
        const message = JSON.parse(event.data);
        if (message?.type === 'identity') {
          if (this.authenticated || Object.keys(message).sort().join(',') !== 'id,type' || typeof message.id !== 'string' || !message.id || message.id.length > 128) throw new Error('Invalid identity');
          if (message.id !== this.identity) {
            this.terminal = true; this.suspend();
            // Shared cookies changed in another tab. Bind the loaded UI to the
            // actual signed-in account before any watch/input can be published.
            window.location.reload();
            return;
          }
          this.authenticated = true;
          if (!this.send({ type: 'watch', context: { ...this.context! } })) this.transportFailed();
          return;
        }
        if (!this.authenticated) throw new Error('Missing identity');
        raw = message as TypingSnapshot;
        if (!raw || Object.keys(raw).sort().join(',') !== 'availability,context,people,type' || raw.type !== 'snapshot' ||
          !raw.context || Object.keys(raw.context).sort().join(',') !== 'id,kind' || raw.context.kind !== this.context!.kind || raw.context.id !== this.context!.id ||
          raw.availability !== 'ready' && raw.availability !== 'unavailable' || !Array.isArray(raw.people) || raw.people.length > 128 ||
          raw.availability === 'unavailable' && raw.people.length || raw.people.some((human) => !human || Object.keys(human).sort().join(',') !== 'id,name' ||
            typeof human.id !== 'string' || !human.id || human.id.length > 128 || human.id === this.identity || typeof human.name !== 'string' || [...human.name].length > 128 || /[\p{Cc}\p{Cf}]/u.test(human.name)) ||
          new Set(raw.people.map((human) => human.id)).size !== raw.people.length) throw new Error('Invalid snapshot');
      } catch { this.suspend(); this.schedule(); return; }
      this.retry = 0;
      this.clearFreshness();
      if (raw.availability === 'ready') this.freshnessTimer = window.setTimeout(() => {
        this.freshnessTimer = null;
        if (current()) { this.suspend(); this.schedule(); }
      }, 3000);
      this.update({ availability: raw.availability, people: raw.people.map((human) => ({ ...human })) });
      if (raw.availability !== 'ready') this.stop();
    };
    socket.onclose = (event) => {
      if (!current()) return;
      this.socket = null; this.epoch++; this.authenticated = false; this.clearFreshness(); this.stop(); this.update(EMPTY);
      if (event.code === 4401) this.terminal = true;
      else this.schedule();
    };
    socket.onerror = () => { /* close owns unavailable/reconnect; no private payload logs */ };
  }
  private schedule() {
    if (!this.started || this.terminal || this.retryTimer !== null || document.visibilityState !== 'visible') return;
    this.retryTimer = window.setTimeout(() => { this.retryTimer = null; this.connect(); }, Math.min(15000, 500 * 2 ** Math.min(5, this.retry++)));
  }
  private clearFreshness() { if (this.freshnessTimer !== null) window.clearTimeout(this.freshnessTimer); this.freshnessTimer = null; }
}
