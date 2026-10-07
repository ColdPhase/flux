import type { ServerResponse } from 'node:http';
import { EditingOutputBudget } from './output.js';

// One public HTTP command has at most six retainers: request context/preparation,
// native journal/preparation, and response source/wire. Sixteen slots also cover
// both listeners and their finite continuation representation within this charge.
const OWNER_BYTES = 4096;
const RETAINERS = 16;

/** Source/context lasts through actual work settlement AND actual response completion.
 * This owner is created synchronously before the first admission/SQL await. */
export function editingHTTPLifetime(raw: ServerResponse, budget: EditingOutputBudget, options: { deferCharge?: boolean } = {}) {
  let releaseOwner = () => {}, charged = false;
  const retained: (() => void)[] = [];
  let workSettled = false, disposed = false;
  // Ordinary roomless map requests observe terminal transport immediately but
  // have no protected live representation. A retained/new room acquires this
  // charge synchronously before its first protected input or admission.
  function protect() {
    if (disposed || charged) return;
    releaseOwner = budget.reserve(OWNER_BYTES); charged = true;
  }
  if (!options.deferCharge) protect();
  // Node24.21's public OutgoingMessage getter is inherited by ServerResponse.
  // The pinned real HTTP tests exercise an owner created after an observed close.
  // writableEnded/destroyed are deliberately not completion evidence.
  let terminal = raw.writableFinished || 'closed' in raw && raw.closed === true;
  const terminalObserved = () => { terminal = true; drain(); };
  function drain() {
    if (disposed || !workSettled || !terminal) return;
    disposed = true;
    raw.removeListener('finish', terminalObserved); raw.removeListener('close', terminalObserved);
    try { for (const release of retained.splice(0)) release(); }
    finally { releaseOwner(); }
  }
  raw.once('finish', terminalObserved); raw.once('close', terminalObserved);
  return {
    protect,
    /** Callers transfer an already charged retainer before any further await.
     * Each current public route's fixed call graph stays below sixteen slots. */
    retain(release: () => void) {
      if (disposed) { release(); return; }
      if (retained.length === RETAINERS) throw new Error('Protected HTTP retainer invariant exceeded');
      retained.push(release);
    },
    get canSend() { return !terminal && !raw.destroyed && !raw.writableEnded; },
    settled() { workSettled = true; drain(); },
  };
}

export type EditingHTTPLifetime = ReturnType<typeof editingHTTPLifetime>;
