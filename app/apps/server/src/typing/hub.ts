import { TypingPresence, decodeTypingPulse, typingContextKey, type TypingAccessPorts, type TypingNotificationPort, type TypingPulse } from '@flux/core';
import type { TypingContext } from '@flux/contracts';
import type { TypingDiagnostics, TypingPhase } from './diagnostics.js';

export interface TypingDelivery {
  context: TypingContext;
  availability: 'ready' | 'unavailable';
  pulses: TypingPulse[];
  generation: number;
  databaseNow: number;
  observedAt: number;
}
export interface TypingSubscriber {
  readonly context: TypingContext | null;
  refresh(delivery: TypingDelivery): void;
  shutdown(): void;
  heartbeat(): void;
}

/** One clock observation/pump, bounded coalescing, and no durable replay per API. */
export class TypingHub {
  readonly presence = new TypingPresence();
  readonly subscribers = new Set<TypingSubscriber>();
  private readonly pending = new Map<string, TypingPulse>();
  private listenerReady = false;
  private clockReady = true;
  private stopped = false;
  private pumping = false;
  private dirty = false;
  private epoch = 0;
  private quarantineExpiry = 0;
  private quarantineUntil = 0;
  private databaseFloor = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly access: TypingAccessPorts, readonly notifications: TypingNotificationPort, readonly diagnostics?: TypingDiagnostics) {
    this.timer = setInterval(() => { for (const subscriber of this.subscribers) subscriber.heartbeat(); this.wake(); }, 1000);
    this.timer.unref();
  }
  get generation() { return this.epoch; }
  measure<T>(phase: Exclude<TypingPhase, 'queue'>, operation: () => Promise<T>) {
    return this.diagnostics ? this.diagnostics.measure(phase, operation) : operation();
  }
  current(pulse: TypingPulse) {
    const pending = this.pending.get(pulse.connectionId);
    const compatible = !pending || pending.sequence <= pulse.sequence || pending.active && pending.actorId === pulse.actorId &&
      pending.sessionId === pulse.sessionId && typingContextKey(pending.context) === typingContextKey(pulse.context);
    return compatible && this.presence.current(pulse, performance.now());
  }
  availableFor(context: TypingContext) { return this.presence.availableFor(context, performance.now()); }
  get work() { return { ...this.presence.work, sockets: this.subscribers.size, pendingBroker: this.pending.size, pumping: this.pumping }; }
  availability(ready: boolean) {
    if (this.stopped) return;
    this.listenerReady = ready;
    this.epoch++;
    this.pending.clear();
    this.presence.setAvailable(ready && !this.quarantineExpiry);
    this.wake();
  }
  notification(payload: string) {
    if (this.stopped || !this.listenerReady) return;
    let pulse: TypingPulse;
    try { pulse = decodeTypingPulse(payload); } catch { return; }
    // Pending sequence reconciliation withdraws superseded senders immediately;
    // unrelated rooms must not starve an authorization already in progress.
    if (this.quarantineExpiry > 0) {
      this.quarantineExpiry = Math.max(this.quarantineExpiry, pulse.expiresAt);
      this.quarantineUntil = Math.max(this.quarantineUntil, performance.now() + 5000);
      this.pending.clear();
      this.epoch++;
      this.presence.setAvailable(false);
    } else if (!this.pending.has(pulse.connectionId) && this.pending.size >= 4096) {
      this.quarantineExpiry = Math.max(pulse.expiresAt, ...[...this.pending.values()].map((item) => item.expiresAt));
      this.quarantineUntil = performance.now() + 5000;
      this.pending.clear();
      this.epoch++;
      this.presence.setAvailable(false);
    } else {
      const previous = this.pending.get(pulse.connectionId);
      if (!previous || pulse.sequence > previous.sequence) this.pending.set(pulse.connectionId, pulse);
    }
    this.wake();
  }
  watch(context: TypingContext) {
    if ([...this.subscribers].filter((subscriber) => subscriber.context && typingContextKey(subscriber.context) === typingContextKey(context)).length >= 128) return false;
    return this.presence.watch(context);
  }
  leave(context: TypingContext) { this.presence.leave(context); this.wake(); }
  wake() {
    if (this.stopped) return;
    this.dirty = true;
    if (!this.pumping) void this.pump();
  }
  private async pump() {
    this.pumping = true;
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        let databaseNow = 0;
        try {
          databaseNow = await this.notifications.now();
          this.databaseFloor = Math.max(this.databaseFloor, databaseNow);
          if (!this.clockReady) { this.clockReady = true; this.epoch++; this.presence.setAvailable(this.listenerReady && !this.quarantineExpiry); }
        }
        catch {
          this.clockReady = false; this.epoch++;
          // Losing the clock must not discard a stop fence then admit an older
          // still-valid notification on recovery. Drain both validity clocks.
          this.quarantineExpiry = Math.max(this.quarantineExpiry, this.databaseFloor + 5000,
            ...[...this.pending.values()].map((pulse) => pulse.expiresAt));
          this.quarantineUntil = Math.max(this.quarantineUntil, performance.now() + 5000);
          this.presence.setAvailable(false); this.pending.clear();
        }
        if (this.stopped) break;
        const observedAt = performance.now();
        const quarantined = this.quarantineUntil > observedAt || this.quarantineExpiry > databaseNow;
        if (databaseNow && this.listenerReady && !quarantined) {
          if (this.quarantineExpiry) { this.quarantineExpiry = this.quarantineUntil = 0; this.epoch++; this.presence.setAvailable(true); }
          // All observations are ordered by this single pump. Older query completions
          // cannot be mistaken for a database clock reversal by the presence store.
          for (const pulse of this.pending.values()) this.presence.accept(pulse, databaseNow, observedAt);
          this.pending.clear();
        } else if (quarantined) {
          for (const pulse of this.pending.values()) this.quarantineExpiry = Math.max(this.quarantineExpiry, pulse.expiresAt);
          this.pending.clear();
        }
        const generation = this.epoch;
        // Capture candidates synchronously for all recipients before any authorization.
        for (const subscriber of this.subscribers) {
          if (!subscriber.context) continue;
          const context = { ...subscriber.context };
          const candidates = databaseNow && this.listenerReady && !quarantined
            ? this.presence.candidates(context, databaseNow, observedAt)
            : { availability: 'unavailable' as const, pulses: [] };
          subscriber.refresh({ context, availability: candidates.availability, pulses: candidates.pulses, generation, databaseNow, observedAt });
        }
      }
    } finally { this.pumping = false; }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.epoch++;
    this.pending.clear();
    this.presence.setAvailable(false);
    for (const subscriber of this.subscribers) subscriber.shutdown();
  }
}
