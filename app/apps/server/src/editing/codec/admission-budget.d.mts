import type { CodecState } from './types.js';
export interface AdmissionLease {
  state: CodecState | null; input: Uint8Array; amount: number; inputCapacity: number; charge: number;
}
export class AdmissionBudget {
  readonly bytes: number; readonly leases: ReadonlySet<AdmissionLease>;
  reserve(state: CodecState, bytes: Uint8Array): AdmissionLease;
  reservePending(bytes: Uint8Array, maximumInputBytes?: number | null): AdmissionLease;
  replaceInput(lease: AdmissionLease, bytes: Uint8Array): void;
  bind(lease: AdmissionLease, state: CodecState): void;
  release(lease: AdmissionLease): void;
  onCapacity(callback: () => void): () => void;
}
