import type { CodecEnvelope, CodecState } from './types.js';
export class Refusal extends Error { readonly code: string; constructor(code: string) }
export function canonical(value: unknown): string;
export function fingerprint(envelope: CodecEnvelope, bytes: Uint8Array): string;
export function stateCharge(state: CodecState): number;
export function emptyRoom(room: string, generation: string, workspace: string): CodecState;
export function enroll(state: CodecState, actor: string, clientId: number, canWrite: boolean): CodecState;
