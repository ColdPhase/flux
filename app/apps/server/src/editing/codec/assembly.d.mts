import type { WikiTextChunk, WikiTextEnvelope } from '@flux/contracts';
export interface CompletedAssembly extends Uint8Array { readonly intent: WikiTextEnvelope }
export class Assemblies {
  readonly bytes: number; readonly pending: ReadonlyMap<string, unknown>;
  receive(connection: string, frame: Uint8Array, trustedContext: Partial<WikiTextEnvelope>, now: number): CompletedAssembly | null;
  intent(connection: string): WikiTextEnvelope | null;
  remove(connection: string): void;
  expire(now: number): void;
}
export function packet(header: WikiTextChunk, chunk: Uint8Array): Uint8Array;
