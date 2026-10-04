import { apiEditingOutputBudget, EditingOutputBudget, EditingOutputError } from './output.js';
import { editingResourcesChanged } from './resource-observation.js';

const PREPARATION_BYTES = 24 * 1024 * 1024;
/** One admitted preparation owns retained continuations and synchronous parser overlap. */
export class EditingPreparation {
  private retained = 0;
  private transient = 0;
  private closed = false;
  constructor(private lease: ReturnType<EditingOutputBudget['lease']>, private releaseInput: () => void) {}
  private resize(retained: number, transient: number) {
    if (this.closed) throw new EditingOutputError('EDITING_OUTPUT_CLOSED');
    this.lease.resize(Math.max(PREPARATION_BYTES, retained + transient));
    this.retained = retained; this.transient = transient;
  }
  reserve = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    this.resize(this.retained + bytes, this.transient);
  };
  temporary = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    this.resize(this.retained, this.transient + bytes);
    let released = false;
    return () => { if (!released) { released = true; if (!this.closed) this.resize(this.retained, this.transient - bytes); } };
  };
  release = () => { if (!this.closed) { this.closed = true; this.lease.release(); this.releaseInput(); } };
}

interface Request { releaseInput: () => void; resolve: (preparation: EditingPreparation) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
type QueueKind='http'|'native'|'wiki';
const actualQueued:Record<QueueKind,number>={http:0,native:0,wiki:0};
export const editingHTTPQueued=()=>({...actualQueued});
/** Request input/context is charged globally before waiting; only one bounded worst-case response is prepared at a time. */
export class EditingHTTPAdmission {
  private waiting: Request[] = [];
  private pumping = false;
  private closed = false;
  private unsubscribe: () => void;
  private observedQueued=0;
  constructor(private budget: EditingOutputBudget, private timeoutMs = 10_000,private kind:QueueKind='http') { this.unsubscribe = budget.onCapacity(() => this.pump()); }
  private changed(){actualQueued[this.kind]+=this.waiting.length-this.observedQueued;this.observedQueued=this.waiting.length;editingResourcesChanged();}
  async admit(inputBytes: number) { return (await this.admitOwned(inputBytes)).release; }
  admitOwned(inputBytes: number) {
    if (this.closed || this.waiting.length >= 8 || inputBytes > 65_536) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const releaseInput = this.budget.reserve(inputBytes);
    return new Promise<EditingPreparation>((resolve, reject) => {
      const item: Request = { releaseInput, resolve, reject, timeout: setTimeout(() => {
        const index = this.waiting.indexOf(item); if (index < 0) return;
        this.waiting.splice(index, 1);this.changed(); releaseInput(); reject(new EditingOutputError('EDITING_OUTPUT_CAPACITY')); this.pump();
      }, this.timeoutMs) };
      item.timeout.unref(); this.waiting.push(item);this.changed(); this.pump();
    });
  }
  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length) {
        const item = this.waiting[0]!; let lease;
        try { lease = this.budget.lease(24 * 1024 * 1024); }
        catch (error) { if (error instanceof EditingOutputError && error.code === 'EDITING_OUTPUT_CAPACITY') break; throw error; }
        this.waiting.shift();this.changed(); clearTimeout(item.timeout);
        item.resolve(new EditingPreparation(lease, item.releaseInput));
      }
    } finally { this.pumping = false; }
  }
  close() {
    this.closed = true; this.unsubscribe();
    const waiting=this.waiting.splice(0);this.changed();
    for (const item of waiting) { clearTimeout(item.timeout); item.releaseInput(); item.reject(new EditingOutputError('EDITING_OUTPUT_CLOSED')); }
  }
  get queued() { return this.waiting.length; }
}

/** Native map and document writes share the same existing eight-waiter admission. */
export const apiNativeEditingAdmission = new EditingHTTPAdmission(apiEditingOutputBudget, 10_000, 'native');
