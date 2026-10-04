import { EditingOutputBudget, EditingOutputError } from './output.js';
interface Request { releaseInput: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
/** Request input/context is charged globally before waiting; only one bounded worst-case response is prepared at a time. */
export class EditingHTTPAdmission {
  private waiting: Request[] = [];
  private pumping = false;
  private closed = false;
  private unsubscribe: () => void;
  constructor(private budget: EditingOutputBudget, private timeoutMs = 10_000) { this.unsubscribe = budget.onCapacity(() => this.pump()); }
  admit(inputBytes: number) {
    if (this.closed || this.waiting.length >= 8 || inputBytes > 65_536) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const releaseInput = this.budget.reserve(inputBytes);
    return new Promise<() => void>((resolve, reject) => {
      const item: Request = { releaseInput, resolve, reject, timeout: setTimeout(() => {
        const index = this.waiting.indexOf(item); if (index < 0) return;
        this.waiting.splice(index, 1); releaseInput(); reject(new EditingOutputError('EDITING_OUTPUT_CAPACITY')); this.pump();
      }, this.timeoutMs) };
      item.timeout.unref(); this.waiting.push(item); this.pump();
    });
  }
  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length) {
        const item = this.waiting[0]!; let releaseResponse;
        try { releaseResponse = this.budget.reserve(24 * 1024 * 1024); }
        catch (error) { if (error instanceof EditingOutputError && error.code === 'EDITING_OUTPUT_CAPACITY') break; throw error; }
        this.waiting.shift(); clearTimeout(item.timeout);
        let finished = false;
        item.resolve(() => { if (!finished) { finished = true; releaseResponse(); item.releaseInput(); } });
      }
    } finally { this.pumping = false; }
  }
  close() {
    this.closed = true; this.unsubscribe();
    for (const item of this.waiting.splice(0)) { clearTimeout(item.timeout); item.releaseInput(); item.reject(new EditingOutputError('EDITING_OUTPUT_CLOSED')); }
  }
  get queued() { return this.waiting.length; }
}
