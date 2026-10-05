/** Optional, injected, in-process measurement. Never a public route or payload log. */
export type TypingPhase = 'command' | 'queue' | 'delivery' | 'session' | 'sender' | 'recipient' | 'publish';
const PHASES: TypingPhase[] = ['command', 'queue', 'delivery', 'session', 'sender', 'recipient', 'publish'];
interface Aggregate { started: number; completed: number; carryIn: number; inFlight: number; peak: number; failed: number; sum: number; max: number; bins: Uint32Array }
const empty = (): Aggregate => ({ started: 0, completed: 0, carryIn: 0, inFlight: 0, peak: 0, failed: 0, sum: 0, max: 0, bins: new Uint32Array(2049) });

/** Fixed 1ms bins, overflow retained, with unfinished work explicitly reported. */
export class TypingDiagnostics {
  private aggregates = new Map<TypingPhase, Aggregate>(PHASES.map((phase) => [phase, empty()]));
  private epoch = 0;
  private published = 0;
  constructor(private readonly accepted?: (activity: Readonly<{ actorId: string; active: boolean }>, at: number) => void) {}
  reset() {
    // A reset starts a new distribution, not a new authority/connection epoch.
    this.epoch++; this.published = 0;
    this.aggregates = new Map(PHASES.map((phase) => {
      const next = empty(); next.carryIn = next.inFlight = next.peak = this.aggregates.get(phase)!.inFlight;
      return [phase, next];
    }));
  }
  recordQueue(startedAt: number) { this.finish('queue', Math.max(0, performance.now() - startedAt), false); }
  async measure<T>(phase: Exclude<TypingPhase, 'queue'>, operation: () => Promise<T>): Promise<T> {
    const aggregate = this.aggregates.get(phase)!;
    aggregate.started++; aggregate.inFlight++; aggregate.peak = Math.max(aggregate.peak, aggregate.inFlight);
    const epoch = this.epoch; const start = performance.now(); let failed = false;
    try { return await operation(); }
    catch (error) { failed = true; throw error; }
    finally {
      aggregate.inFlight--;
      if (epoch === this.epoch) this.finish(phase, performance.now() - start, failed);
      else this.aggregates.get(phase)!.inFlight--;
    }
  }
  publication(actorId: string, active: boolean) {
    this.published++;
    try { this.accepted?.(Object.freeze({ actorId, active }), performance.now()); }
    catch { /* An observer cannot alter publication, policy or connection cleanup. */ }
  }
  private finish(phase: TypingPhase, elapsed: number, failed: boolean) {
    if (!Number.isFinite(elapsed) || elapsed < 0) return;
    const item = this.aggregates.get(phase)!;
    if (phase === 'queue') item.started++;
    item.completed++; item.sum += elapsed; item.max = Math.max(item.max, elapsed);
    if (failed) item.failed++;
    item.bins[Math.min(2048, Math.ceil(elapsed))]++;
  }
  snapshot() {
    return { published: this.published, phases: Object.fromEntries(PHASES.map((phase) => {
      const item = this.aggregates.get(phase)!;
      const percentile = (ratio: number) => {
        if (!item.completed) return null;
        const goal = Math.ceil(item.completed * ratio); let count = 0;
        for (let bin = 0; bin < item.bins.length; bin++) {
          count += item.bins[bin]!;
          if (count >= goal) return bin === 2048 ? null : bin;
        }
        return null;
      };
      return [phase, { started: item.started, completed: item.completed, carryIn: item.carryIn, inFlight: item.inFlight, peak: item.peak, failed: item.failed,
        meanMs: item.completed ? item.sum / item.completed : null, maxMs: item.max, p50UpperMs: percentile(.5), p95UpperMs: percentile(.95),
        overflow2048Ms: item.bins[2048] }];
    })) };
  }
}
