import type { TypingContext } from '@flux/contracts';
import { typingContextKey } from './commands.js';

export const TYPING_TTL_MS = 5000;
/** Internal server metadata only. Entry points must validate/authenticate broker input. */
export interface TypingPulse {
  connectionId: string;
  actorId: string;
  sessionId: string;
  context: TypingContext;
  sequence: number;
  active: boolean;
  /** From the database clock; never the browser or an API host's wall clock. */
  expiresAt: number;
}
interface Entry { pulse: TypingPulse; deadline: number; active: boolean }
/** Anonymous sequence fence: no actor, session, name or foreign context. */
interface Watermark { sequence: number; expiresAt: number }
interface Quarantine { until: number; expiry: number }
interface Watched extends Quarantine { count: number }
export interface TypingPresenceLimits { contexts: number; perContext: number; entries: number }
const DEFAULT_LIMITS: Readonly<TypingPresenceLimits> = Object.freeze({ contexts: 128, perContext: 512, entries: 4096 });

/**
 * Injected per API. No cookies/names/drafts or authorization caches.
 * Callers recheck current sender/receiver authority before displaying candidates.
 * Monotonic time bounds positive presence; negative fences survive through database validity.
 */
export class TypingPresence {
  private readonly watched = new Map<string, Watched>();
  private readonly entries = new Map<string, Entry>();
  private readonly watermarks = new Map<string, Watermark>();
  private readonly limits: Readonly<TypingPresenceLimits>;
  private available = false;
  private generation = 0;
  private databaseFloor = -Infinity;
  private clockBehind = false;
  private readonly saturated: Quarantine = { until: 0, expiry: 0 };
  constructor(limits: TypingPresenceLimits = DEFAULT_LIMITS) {
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof TypingPresenceLimits)[]) {
      if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error('Invalid typing presence limit');
    }
    this.limits = Object.freeze({ ...limits });
  }
  /** Listener start/loss/reconnect/shutdown fences every in-flight authorization. */
  setAvailable(available: boolean) {
    this.generation++;
    this.available = available;
    this.entries.clear();
    this.watermarks.clear();
    this.saturated.until = this.saturated.expiry = 0;
    for (const room of this.watched.values()) room.until = room.expiry = 0;
  }
  get revision() { return this.generation; }
  watch(context: TypingContext): boolean {
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (room) { room.count++; return true; }
    if (this.watched.size >= this.limits.contexts) return false;
    this.watched.set(key, { count: 1, until: 0, expiry: 0 });
    this.generation++;
    return true;
  }
  leave(context: TypingContext) {
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (!room) return;
    if (--room.count > 0) return;
    this.watched.delete(key);
    for (const entry of this.entries.values()) if (typingContextKey(entry.pulse.context) === key) entry.active = false;
    this.generation++;
  }
  private prune(databaseNow: number, monotonicNow: number): number {
    const behind = databaseNow < this.databaseFloor;
    if (behind !== this.clockBehind) this.generation++;
    this.clockBehind = behind;
    this.databaseFloor = Math.max(this.databaseFloor, databaseNow);
    databaseNow = this.databaseFloor;
    if (behind) {
      for (const entry of this.entries.values()) {
        if (entry.active) { entry.active = false; this.generation++; }
      }
    }
    for (const [id, watermark] of this.watermarks) {
      if (watermark.expiresAt <= databaseNow) {
        this.watermarks.delete(id);
        this.entries.delete(id);
        this.generation++;
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.active && entry.deadline <= monotonicNow) { entry.active = false; this.generation++; }
    }
    return databaseNow;
  }
  private quarantined(state: Quarantine, databaseNow: number, monotonicNow: number) {
    return state.until > monotonicNow || state.expiry > databaseNow;
  }
  private quarantine(state: Quarantine, pulse: TypingPulse, monotonicNow: number) {
    state.until = Math.max(state.until, monotonicNow + TYPING_TTL_MS);
    state.expiry = Math.max(state.expiry, pulse.expiresAt);
  }
  private quarantineAll(pulse: TypingPulse, monotonicNow: number) {
    this.quarantine(this.saturated, pulse, monotonicNow);
    for (const entry of this.entries.values()) entry.active = false;
    this.generation++;
  }
  /** Latest sequence replaces the WHOLE connection before filtering its new scope. */
  accept(pulse: TypingPulse, databaseNow: number, monotonicNow: number): boolean {
    databaseNow = this.prune(databaseNow, monotonicNow);
    if (!this.available || !Number.isSafeInteger(pulse.sequence) || pulse.sequence < 1 ||
      !Number.isFinite(pulse.expiresAt) || pulse.expiresAt <= databaseNow) return false;
    const watermark = this.watermarks.get(pulse.connectionId);
    const previous = this.entries.get(pulse.connectionId);
    // Carry an existing expiry fence through backward clock correction, but never grow it
    // beyond that fence or a fresh TTL. Negative fences are retained until DB validity ends.
    if (pulse.expiresAt > Math.max(databaseNow + TYPING_TTL_MS, watermark?.expiresAt ?? 0)) return false;
    if (watermark && (pulse.sequence <= watermark.sequence || pulse.expiresAt < watermark.expiresAt)) return false;
    if (previous && (previous.pulse.actorId !== pulse.actorId || previous.pulse.sessionId !== pulse.sessionId)) return false;
    if (!watermark && this.watermarks.size >= this.limits.entries) {
      // No space for its stop fence. Quarantine every discarded update through its validity.
      this.quarantineAll(pulse, monotonicNow);
      return false;
    }
    this.watermarks.set(pulse.connectionId, { sequence: pulse.sequence, expiresAt: pulse.expiresAt });
    this.generation++;
    if (previous) {
      // Unwatched B still withdraws A. Keep the earlier context only as an inactive record.
      previous.active = false;
      previous.pulse = { ...pulse, context: { ...previous.pulse.context } };
      previous.deadline = monotonicNow + TYPING_TTL_MS;
    }
    const key = typingContextKey(pulse.context);
    const room = this.watched.get(key);
    if (this.quarantined(this.saturated, databaseNow, monotonicNow)) {
      this.quarantineAll(pulse, monotonicNow);
      return false;
    }
    // Only the anonymous sequence fence of foreign activity is retained, not its metadata.
    if (!room) return false;
    if (this.clockBehind) return !pulse.active;
    if (this.quarantined(room, databaseNow, monotonicNow)) {
      this.quarantine(room, pulse, monotonicNow);
      return false;
    }
    const inContext = [...this.entries.values()].filter((entry) => entry.pulse.connectionId !== pulse.connectionId && typingContextKey(entry.pulse.context) === key).length;
    if (inContext >= this.limits.perContext) {
      this.quarantine(room, pulse, monotonicNow);
      for (const entry of this.entries.values()) if (typingContextKey(entry.pulse.context) === key) entry.active = false;
      return false;
    }
    this.entries.set(pulse.connectionId, { pulse: { ...pulse, context: { ...pulse.context } }, deadline: monotonicNow + TYPING_TTL_MS, active: pulse.active });
    return true;
  }
  /** Internal candidates, not a public snapshot and not proof of access. */
  candidates(context: TypingContext, databaseNow: number, monotonicNow: number): { availability: 'ready' | 'unavailable'; pulses: TypingPulse[]; revision: number } {
    databaseNow = this.prune(databaseNow, monotonicNow);
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (!this.available || this.clockBehind || !room || this.quarantined(this.saturated, databaseNow, monotonicNow) || this.quarantined(room, databaseNow, monotonicNow))
      return { availability: 'unavailable', pulses: [], revision: this.generation };
    return { availability: 'ready', pulses: [...this.entries.values()].filter((entry) => entry.active && typingContextKey(entry.pulse.context) === key).map((entry) => ({ ...entry.pulse, context: { ...entry.pulse.context } })), revision: this.generation };
  }
  /** Safe counters for bounded-stress evidence; no identifiers or names. */
  get work() { return { contexts: this.watched.size, entries: this.entries.size, watermarks: this.watermarks.size }; }
  /** Synchronous final reconciliation, without another out-of-order DB observation. */
  current(pulse: TypingPulse, monotonicNow: number): boolean {
    const entry = this.entries.get(pulse.connectionId);
    return this.availableFor(pulse.context, monotonicNow) &&
      !!entry?.active && entry.deadline > monotonicNow && entry.pulse.expiresAt > this.databaseFloor &&
      entry.pulse.sequence >= pulse.sequence && entry.pulse.actorId === pulse.actorId && entry.pulse.sessionId === pulse.sessionId &&
      typingContextKey(entry.pulse.context) === typingContextKey(pulse.context);
  }
  availableFor(context: TypingContext, monotonicNow: number): boolean {
    const room = this.watched.get(typingContextKey(context));
    return this.available && !this.clockBehind && !!room &&
      !this.quarantined(this.saturated, this.databaseFloor, monotonicNow) && !this.quarantined(room, this.databaseFloor, monotonicNow);
  }
}
