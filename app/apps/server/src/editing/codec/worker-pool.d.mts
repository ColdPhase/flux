import type { CodecEnvelope, CodecResult, CodecState } from './types.js';
import type { AdmissionBudget, AdmissionLease } from './admission-budget.mjs';
export class CodecPool {
  readonly budget: AdmissionBudget;
  readonly externalBytes: number;
  run(state: CodecState, envelope: CodecEnvelope, bytes: Uint8Array, options?: { canWrite?: boolean; signal?: AbortSignal; admission?: AdmissionLease }): Promise<CodecResult>;
  close(): Promise<void>;
}
