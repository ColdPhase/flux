import type { CodecEnvelope, CodecResult, CodecState } from './types.js';
import type { AdmissionBudget, AdmissionLease } from './admission-budget.mjs';
export class CodecPool {
  readonly budget: AdmissionBudget;
  readonly externalBytes: number;
  /** Actual public CodecPool constructor/acquire/release state; observed without mutating the queue. */
  readonly active: number;
  readonly waiting: readonly { resolve: () => void; reject: (error: unknown) => void }[];
  run(state: CodecState, envelope: CodecEnvelope, bytes: Uint8Array, options?: { canWrite?: boolean; signal?: AbortSignal; admission?: AdmissionLease }): Promise<CodecResult>;
  close(): Promise<void>;
}
