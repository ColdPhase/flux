import { EditingOutputBudget, EditingOutputError } from './output.js';
import { editingResourcesChanged } from './resource-observation.js';
interface Request { ticket: number; releaseInput: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
type QueueKind='http'|'native'|'wiki';
const actualQueued:Record<QueueKind,number>={http:0,native:0,wiki:0};
export const editingHTTPQueued=()=>({...actualQueued});
/** Arrival order across every admission that shares one output budget. */
let tickets=0;
const sharing=new WeakMap<EditingOutputBudget,Set<EditingHTTPAdmission>>();
/** Request input/context is charged globally before waiting; only one bounded worst-case response is prepared at a time. */
export class EditingHTTPAdmission {
  private waiting: Request[] = [];
  private pumping = false;
  private closed = false;
  private unsubscribe: () => void;
  private observedQueued=0;
  private peers: Set<EditingHTTPAdmission>;
  constructor(private budget: EditingOutputBudget, private timeoutMs = 10_000,private kind:QueueKind='http') {
    this.unsubscribe = budget.onCapacity(() => this.pump());
    let peers=sharing.get(budget);if(!peers)sharing.set(budget,peers=new Set());peers.add(this);this.peers=peers;
  }
  private get oldest() { return this.waiting[0]?.ticket ?? Infinity; }
  private changed(){actualQueued[this.kind]+=this.waiting.length-this.observedQueued;this.observedQueued=this.waiting.length;editingResourcesChanged();}
  admit(inputBytes: number) {
    if (this.closed || this.waiting.length >= 8 || inputBytes > 65_536) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const releaseInput = this.budget.reserve(inputBytes);
    return new Promise<() => void>((resolve, reject) => {
      const item: Request = { ticket: ++tickets, releaseInput, resolve, reject, timeout: setTimeout(() => {
        const index = this.waiting.indexOf(item); if (index < 0) return;
        this.waiting.splice(index, 1);this.changed(); releaseInput(); reject(new EditingOutputError('EDITING_OUTPUT_CAPACITY')); this.pumpAll();
      }, this.timeoutMs) };
      item.timeout.unref(); this.waiting.push(item);this.changed(); this.pump();
    });
  }
  private pumpAll() { for (const peer of [...this.peers]) peer.pump(); }
  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true; let admitted = false;
    try {
      while (this.waiting.length) {
        const item = this.waiting[0]!; let releaseResponse;
        // Requests take their turns in arrival order across every admission of this budget.
        // Otherwise whichever admission is notified first takes all released capacity: live
        // wiki reads starved enrollment renewals into 10 s refusals and reconnects (#228 Gate 4).
        if ([...this.peers].some((peer) => peer.oldest < item.ticket)) break;
        try { releaseResponse = this.budget.reserve(24 * 1024 * 1024); }
        catch (error) { if (error instanceof EditingOutputError && error.code === 'EDITING_OUTPUT_CAPACITY') break; throw error; }
        this.waiting.shift();this.changed(); clearTimeout(item.timeout);
        let finished = false;
        item.resolve(() => { if (!finished) { finished = true; releaseResponse(); item.releaseInput(); } });
        admitted = true;
      }
    } finally { this.pumping = false; }
    if (admitted) this.pumpAll();
  }
  close() {
    this.closed = true; this.unsubscribe(); this.peers.delete(this);
    const waiting=this.waiting.splice(0);this.changed();
    for (const item of waiting) { clearTimeout(item.timeout); item.releaseInput(); item.reject(new EditingOutputError('EDITING_OUTPUT_CLOSED')); }
  }
  get queued() { return this.waiting.length; }
}
