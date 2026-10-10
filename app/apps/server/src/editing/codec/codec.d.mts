import type { CodecEnvelope, CodecLedgerDelta, CodecState } from './types.js';
export class Refusal extends Error { readonly code: string; constructor(code: string) }
export function canonical(value: unknown): string;
export function fingerprint(envelope: CodecEnvelope, bytes: Uint8Array): string;
export function stateCharge(state: CodecState): number;
export function emptyRoom(room: string, generation: string, workspace: string): CodecState;
export function enroll(state: CodecState, actor: string, clientId: number, canWrite: boolean): CodecState;
export function ledgerDelta(previous: CodecState, next: CodecState): CodecLedgerDelta;
export function rebuild(base: CodecState, entries: readonly { sequence: number; bytes: Uint8Array; ledger: CodecLedgerDelta }[], expectedBody?: string): CodecState;
export function admit(state: CodecState, envelope: CodecEnvelope, bytes: Uint8Array, canWrite: boolean):
  { replay: false; receipt: { semanticNoop: boolean; sequence: number; fingerprint: string }; state: CodecState; receiptOnly: boolean };
