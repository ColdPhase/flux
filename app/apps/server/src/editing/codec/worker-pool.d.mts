import type { ResourceLimits, Worker } from 'node:worker_threads';
import type { CodecEnvelope, CodecResult, CodecState } from './types.js';
import type { AdmissionBudget, AdmissionLease } from './admission-budget.mjs';
export class CodecPool {
  constructor(changed?: () => void);
  readonly budget: AdmissionBudget;
  readonly externalBytes: number;
  /** Actual public CodecPool constructor/acquire/release state; observed without mutating the queue. */
  readonly active: number;
  readonly waiting: readonly { resolve: () => void; reject: (error: unknown) => void }[];
  /** Workers running a task now, and the at most CAPS.workers codec workers kept for the next task. */
  readonly running: ReadonlySet<Worker>;
  readonly idle: readonly Worker[];
  run(state: CodecState, envelope: CodecEnvelope, bytes: Uint8Array, options?: { canWrite?: boolean; signal?: AbortSignal; admission?: AdmissionLease }): Promise<CodecResult & { workerLimits?: ResourceLimits }>;
  close(): Promise<void>;
}
