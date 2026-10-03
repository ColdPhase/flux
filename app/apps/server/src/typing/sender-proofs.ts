import { authorizeTypingSender, typingContextKey, type TypingAccessPorts, type TypingPulse } from '@flux/core';
import type { TypingContext } from '@flux/contracts';

export interface SenderProof {
  readonly people: readonly { readonly pulse: TypingPulse; readonly human: Readonly<{ id: string; name: string }> }[];
  readonly expiresAt: number;
}
interface Job {
  readonly context: TypingContext;
  readonly pulses: readonly TypingPulse[];
  readonly valid: () => boolean;
  readonly settle: (proof: SenderProof | null) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}
interface Slot { readonly context: TypingContext; running: Job | null; pending: Job | null; latestCycle: number; retiring: boolean }

/** One immutable proof per delivery cycle; no authority cache between cycles. */
export class TypingSenderProofs {
  private readonly slots = new Map<string, Slot>();
  private running = 0;
  private pending = 0;
  private captured = 0;
  private stopped = false;
  private nextCycle = 0;
  private peaks = { contexts: 0, running: 0, pending: 0, captured: 0 };
  constructor(private readonly access: TypingAccessPorts,
    private readonly measure: <T>(operation: () => Promise<T>) => Promise<T>) {}
  get work() { return { contexts: this.slots.size, running: this.running, pending: this.pending, captured: this.captured, peaks: { ...this.peaks } }; }
  private observe() {
    this.peaks.contexts = Math.max(this.peaks.contexts, this.slots.size);
    this.peaks.running = Math.max(this.peaks.running, this.running);
    this.peaks.pending = Math.max(this.peaks.pending, this.pending);
    this.peaks.captured = Math.max(this.peaks.captured, this.captured);
  }
  request(context: TypingContext, pulses: readonly TypingPulse[], valid: () => boolean, cycle = ++this.nextCycle): Promise<SenderProof | null> {
    if (this.stopped || !valid()) return Promise.resolve(null);
    const key = typingContextKey(context);
    let slot = this.slots.get(key);
    if (slot && cycle <= slot.latestCycle) return Promise.resolve(null);
    // Retire an obsolete pending cycle before testing the replacement's capacity.
    if (slot?.pending) this.retirePending(slot);
    if ((!slot && this.slots.size >= 128) || this.captured + pulses.length > 4096) {
      if (slot) slot.latestCycle = Math.max(slot.latestCycle, cycle);
      return Promise.reject(new Error('Typing proof capacity unavailable'));
    }
    if (!slot) { slot = { context: Object.freeze({ ...context }), running: null, pending: null, latestCycle: cycle, retiring: false }; this.slots.set(key, slot); }
    slot.latestCycle = cycle; slot.retiring = false;
    const result = new Promise<SenderProof | null>((settle, reject) => {
      slot!.pending = { context: Object.freeze({ ...context }), pulses: Object.freeze(pulses.map((pulse) => Object.freeze({ ...pulse, context: Object.freeze({ ...pulse.context }) }))), valid, settle, reject, cancelled: false };
    });
    this.pending++; this.captured += pulses.length; this.observe(); this.drain();
    return result;
  }
  private retirePending(slot: Slot) {
    const job = slot.pending!; slot.pending = null;
    this.pending--; this.captured -= job.pulses.length; job.cancelled = true; job.settle(null);
  }
  invalidate(matches: (context: TypingContext, pulses: readonly TypingPulse[]) => boolean = () => true, forget = false) {
    for (const [key, slot] of this.slots) {
      const matching = slot.running ? matches(slot.running.context, slot.running.pulses) : slot.pending ? matches(slot.pending.context, slot.pending.pulses) : matches(slot.context, []);
      if (forget && matching) slot.retiring = true;
      if (slot.running && matches(slot.running.context, slot.running.pulses)) slot.running.cancelled = true;
      if (slot.pending && matches(slot.pending.context, slot.pending.pulses)) this.retirePending(slot);
      // Running SQL keeps its reservation even after every socket has departed.
      if (slot.retiring && !slot.running && !slot.pending) this.slots.delete(key);
    }
  }
  private drain() {
    if (this.stopped) return;
    for (const [key, slot] of this.slots) {
      if (this.running >= 4) return;
      if (slot.running || !slot.pending) continue;
      const job = slot.pending; slot.pending = null; slot.running = job;
      this.pending--; this.running++;
      // Reinsert at the tail, giving already queued contexts priority next time.
      this.slots.delete(key); this.slots.set(key, slot); this.observe();
      void this.run(job).then(job.settle, job.reject).finally(() => {
        this.running--; this.captured -= job.pulses.length; slot.running = null;
        if (slot.retiring && !slot.pending) this.slots.delete(key);
        this.drain();
      });
    }
  }
  private async run(job: Job): Promise<SenderProof | null> {
    const people: { pulse: TypingPulse; human: Readonly<{ id: string; name: string }> }[] = [];
    let expiresAt = Infinity;
    for (const pulse of job.pulses) {
      if (job.cancelled || !job.valid()) return null;
      const human = await this.measure(() => authorizeTypingSender(this.access, pulse));
      if (job.cancelled || !job.valid()) return null;
      if (human) {
        expiresAt = Math.min(expiresAt, performance.now() + 1000);
        people.push(Object.freeze({ pulse, human: Object.freeze({ ...human }) }));
      }
    }
    if (job.cancelled || !job.valid()) return null;
    return Object.freeze({ people: Object.freeze(people), expiresAt });
  }
  close() { this.stopped = true; this.invalidate(() => true, true); }
}
