import { EditingOutputBudget, EditingOutputError } from './output.js';
import { editingResourcesChanged } from './resource-observation.js';
interface Request { releaseInput: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
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
  admit(inputBytes: number) {
    if (this.closed || this.waiting.length >= 8 || inputBytes > 65_536) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const releaseInput = this.budget.reserve(inputBytes);
    return new Promise<() => void>((resolve, reject) => {
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
        const item = this.waiting[0]!; let releaseResponse;
        try { releaseResponse = this.budget.reserve(24 * 1024 * 1024); }
        catch (error) { if (error instanceof EditingOutputError && error.code === 'EDITING_OUTPUT_CAPACITY') break; throw error; }
        this.waiting.shift();this.changed(); clearTimeout(item.timeout);
        let finished = false;
        item.resolve(() => { if (!finished) { finished = true; releaseResponse(); item.releaseInput(); } });
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
