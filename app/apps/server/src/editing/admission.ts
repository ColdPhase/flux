import { Refusal } from './codec/codec.mjs';
import type { AdmissionBudget, AdmissionLease } from './codec/admission-budget.mjs';

interface Waiting { lease: AdmissionLease; resolve: (lease: AdmissionLease) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
/** FIFO contains only leases whose full input/metadata are already charged; no SQL/hash can precede promotion. */
export class EditingAdmission {
  private waiting: Waiting[] = [];
  private closing = false;
  private pumping = false;
  private unsubscribe: () => void;
  constructor(private budget: AdmissionBudget, private timeoutMs = 10_000) { this.unsubscribe = budget.onCapacity(() => this.pump()); }
  reserve(bytes: Uint8Array, metadataBytes: number, maximumInputBytes?: number) {
    if (this.closing) throw new Refusal('POOL_CLOSED');
    // This synchronous step happens before constructing an awaiting continuation.
    const lease = this.budget.reserveQueued(bytes, metadataBytes, maximumInputBytes);
    return new Promise<AdmissionLease>((resolve, reject) => {
      const item: Waiting = { lease, resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1); this.budget.release(item.lease); item.reject(new Refusal('ADMISSION_TIMEOUT')); this.pump();
      }, this.timeoutMs) };
      item.timer.unref(); this.waiting.push(item); this.pump();
    });
  }
  private pump() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length) {
        const item = this.waiting[0]!;
        try { this.budget.promote(item.lease); }
        catch (error) {
          if (error instanceof Refusal && error.code === 'EXTERNAL_BUFFER_LIMIT') break;
          this.waiting.shift(); clearTimeout(item.timer); this.budget.release(item.lease); item.reject(error); continue;
        }
        this.waiting.shift(); clearTimeout(item.timer); item.resolve(item.lease);
      }
    } finally { this.pumping = false; }
  }
  close() {
    this.closing = true; this.unsubscribe();
    for (const item of this.waiting.splice(0)) { clearTimeout(item.timer); this.budget.release(item.lease); item.reject(new Refusal('POOL_CLOSED')); }
  }
  get queued() { return this.waiting.length; }
}
