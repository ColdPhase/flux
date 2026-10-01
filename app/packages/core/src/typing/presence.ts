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
interface Watched { count: number; unavailableUntil: number }
export interface TypingPresenceLimits { contexts: number; perContext: number; entries: number }
const DEFAULT_LIMITS: TypingPresenceLimits = { contexts: 128, perContext: 512, entries: 4096 };

/**
 * Injected per API. Contains references only, not cookies/names/drafts or authorization caches.
 * Callers recheck current sender/receiver authority before displaying candidates.
 * `monotonicNow` bounds retention even if the shared database wall clock moves backwards.
 */
export class TypingPresence {
  private readonly watched = new Map<string, Watched>();
  private readonly entries = new Map<string, Entry>();
  private available = false;
  private generation = 0;
  private saturatedUntil = 0;
  constructor(private readonly limits: TypingPresenceLimits = DEFAULT_LIMITS) {
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof TypingPresenceLimits)[]) {
      if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error('Invalid typing presence limit');
    }
  }
  /** Listener start/loss/reconnect/shutdown fences every in-flight authorization. */
  setAvailable(available: boolean) {
    this.generation++;
    this.available = available;
    this.entries.clear();
    this.saturatedUntil = 0;
    for (const room of this.watched.values()) room.unavailableUntil = 0;
  }
  get revision() { return this.generation; }
  watch(context: TypingContext): boolean {
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (room) { room.count++; return true; }
    if (this.watched.size >= this.limits.contexts) return false;
    this.watched.set(key, { count: 1, unavailableUntil: 0 });
    this.generation++;
    return true;
  }
  leave(context: TypingContext) {
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (!room) return;
    if (--room.count > 0) return;
    this.watched.delete(key);
    // Preserve sequence tombstones until their original TTL, but never retain visible activity.
    for (const entry of this.entries.values()) if (typingContextKey(entry.pulse.context) === key) entry.active = false;
    this.generation++;
  }
  private prune(databaseNow: number, monotonicNow: number) {
    for (const [id, entry] of this.entries) {
      if (entry.pulse.expiresAt <= databaseNow || entry.deadline <= monotonicNow) { this.entries.delete(id); this.generation++; }
    }
  }
  /** Latest sequence replaces the WHOLE connection before filtering its new scope. */
  accept(pulse: TypingPulse, databaseNow: number, monotonicNow: number): boolean {
    this.prune(databaseNow, monotonicNow);
    if (!this.available || !Number.isSafeInteger(pulse.sequence) || pulse.sequence < 1 ||
      !Number.isFinite(pulse.expiresAt) || pulse.expiresAt <= databaseNow || pulse.expiresAt > databaseNow + TYPING_TTL_MS) return false;
    const previous = this.entries.get(pulse.connectionId);
    if (previous && pulse.sequence <= previous.pulse.sequence) return false;
    if (previous && (previous.pulse.actorId !== pulse.actorId || previous.pulse.sessionId !== pulse.sessionId || pulse.expiresAt < previous.pulse.expiresAt)) return false;
    const key = typingContextKey(pulse.context);
    const room = this.watched.get(key);
    if (previous) {
      // Unwatched B still withdraws previously visible A. Never coalesce this withdrawal away.
      previous.active = false;
      previous.pulse = { ...pulse, context: { ...previous.pulse.context } };
      previous.deadline = monotonicNow + TYPING_TTL_MS;
      this.generation++;
    }
    if (!room || this.saturatedUntil > monotonicNow || room.unavailableUntil > monotonicNow) return false;
    if (!previous && this.entries.size >= this.limits.entries) {
      // Keep all necessary tombstones; clear visible activity rather than expose an incomplete set.
      this.saturatedUntil = monotonicNow + TYPING_TTL_MS;
      for (const entry of this.entries.values()) entry.active = false;
      this.generation++;
      return false;
    }
    const inContext = [...this.entries.values()].filter((entry) => entry.pulse.connectionId !== pulse.connectionId && typingContextKey(entry.pulse.context) === key).length;
    if (inContext >= this.limits.perContext) {
      room.unavailableUntil = monotonicNow + TYPING_TTL_MS;
      for (const entry of this.entries.values()) if (typingContextKey(entry.pulse.context) === key) entry.active = false;
      this.generation++;
      return false;
    }
    this.entries.set(pulse.connectionId, { pulse: { ...pulse, context: { ...pulse.context } }, deadline: monotonicNow + TYPING_TTL_MS, active: pulse.active });
    this.generation++;
    return true;
  }
  /** Internal candidates, not a public snapshot and not proof of access. */
  candidates(context: TypingContext, databaseNow: number, monotonicNow: number): { availability: 'ready' | 'unavailable'; pulses: TypingPulse[]; revision: number } {
    this.prune(databaseNow, monotonicNow);
    const key = typingContextKey(context);
    const room = this.watched.get(key);
    if (!this.available || !room || this.saturatedUntil > monotonicNow || room.unavailableUntil > monotonicNow)
      return { availability: 'unavailable', pulses: [], revision: this.generation };
    return { availability: 'ready', pulses: [...this.entries.values()].filter((entry) => entry.active && typingContextKey(entry.pulse.context) === key).map((entry) => ({ ...entry.pulse, context: { ...entry.pulse.context } })), revision: this.generation };
  }
  /** Safe counters for bounded-stress evidence; no identifiers or names. */
  get work() { return { contexts: this.watched.size, entries: this.entries.size }; }
}
