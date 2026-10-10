import type { WikiTextEnvelope } from '@flux/contracts';

export interface CodecRef { client: number; clock: number }
export interface CodecNode {
  client: number; clock: number; length: number; text: string;
  origin: CodecRef | null; rightOrigin: CodecRef | null; declaredRoot: 'body'; root: 'body';
  actor: string; admittedSequence: number;
}
export interface CodecReceipt {
  fingerprint: string; bytes: number; sequence: number;
  workspace: string; kind: 'wiki'; room: string; generation: string; actor: string; uuid: string; replica: number;
  semanticNoop: boolean; provenance: { actor: string; sequence: number } | null;
}
export interface CodecState extends Record<string, unknown> {
  workspace: string; kind: 'wiki'; room: string; generation: string; body: string; sequence: number; checkpoint: string;
  nodes: CodecNode[];
  deleted: { client: number; clock: number; length: number; actor: string; admittedSequence: number }[];
  splits: CodecRef[];
  enrollments: Record<string, { actor: string; workspace: string; kind: 'wiki'; room: string; generation: string }>;
}
/** What one admitted change appended to the ledger; logged beside its update bytes. */
export interface CodecLedgerDelta { nodes: CodecNode[]; deleted: CodecState['deleted']; splits: CodecRef[] }
export type CodecResult = { ok: false; code: string } | {
  ok: true; state: CodecState; receipt: CodecReceipt; replay: boolean; receiptOnly?: boolean;
};
export type CodecEnvelope = WikiTextEnvelope;
