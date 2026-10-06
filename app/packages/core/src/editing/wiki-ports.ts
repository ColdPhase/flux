import type { EnrolledLiveDoc, LiveReceipt, LiveCursor, NamedPrincipal, WikiTextEnvelope } from '@flux/contracts';
import type { DocPorts, DocWithCurrent } from '../docs/ports.js';
import type { LiveDocHead } from './doc-ports.js';

/** Persisted server codec, opaque to the domain except its confirmed head and public checkpoint. */
export interface WikiCodecState extends Record<string, unknown> {
  workspace: string; kind: 'wiki'; room: string; generation: string;
  body: string; sequence: number; checkpoint: string;
}
export interface WikiHead<State extends WikiCodecState> extends LiveDocHead {
  workspaceId: string; projectId: string; resourceId: string; codecState: State | null;
}
export interface WikiIdentity { sessionId: string; actorId: string }
export interface WikiSession {
  /** Current SQL session FOR SHARE; deleting/expiring authentication cannot race protected handoff. */
  lock(identity: WikiIdentity): Promise<NamedPrincipal>;
  /** SQL clock checked after asynchronous validation/rendering, immediately before commit/handoff. */
  assertCurrent(identity: WikiIdentity): Promise<void>;
}
export interface WikiIntent {
  actorId: string; commandId: string; workspaceId: string; kind: 'wiki' | 'map'; resourceId: string;
  generation: string; operation: string; fingerprint: string; byteLength: number; receipt: unknown;
}
export interface WikiReplica {
  ownerKind: 'human' | 'server'; actorId: string | null; instanceId: string; expiresAt: Date;
}
export interface WikiUpdate {
  sequence: number; bytes: Uint8Array; commandId: string; actor: NamedPrincipal; hash: string;
}
export interface WikiPresence { connectionId: string; actor: NamedPrincipal; cursor: LiveCursor; expiresAt: string }
/** The locked head without its codec state: a confirmed read needs only whether it is initialized. */
export type WikiHeadSummary = Omit<WikiHead<WikiCodecState>, 'codecState'> & { initialized: boolean };
export interface WikiRows<State extends WikiCodecState> {
  lockHead(docId: string): Promise<WikiHead<State> | null>;
  /** The same row lock as lockHead, without transferring or decoding the codec state. */
  lockHeadSummary(docId: string): Promise<WikiHeadSummary | null>;
  insertHead(doc: DocWithCurrent, generation: string, state: State): Promise<WikiHead<State>>;
  replaceState(head: WikiHead<State>, state: State, hash: string): Promise<void>;
  replica(docId: string, generation: string, replicaId: number): Promise<WikiReplica | null>;
  insertReplica(docId: string, generation: string, replicaId: number, actorId: string | null, instanceId: string, ownerKind: 'human' | 'server'): Promise<EnrolledLiveDoc>;
  renewReplica(docId: string, generation: string, replicaId: number, instanceId: string): Promise<EnrolledLiveDoc>;
  /** Advisory actor/UUID lock, shared across every room and operation; held until transaction end. */
  lockIntent(actorId: string, commandId: string): Promise<void>;
  intent(actorId: string, commandId: string): Promise<WikiIntent | null>;
  insertIntent(intent: Omit<WikiIntent, 'receipt'> & { receipt: LiveReceipt }): Promise<void>;
  appendUpdate(head: WikiHead<State>, envelope: WikiTextEnvelope, bytes: Uint8Array, fingerprint: string): Promise<void>;
  updates(docId: string, generation: string, afterSequence: number, limit: number): Promise<WikiUpdate[]>;
  setPresence(docId: string, generation: string, identity: WikiIdentity, connectionId: string, cursor: LiveCursor | null): Promise<void>;
  presence(docId: string, generation: string): Promise<WikiPresence[]>;
  /** PostgreSQL transactional NOTIFY identifiers only; no ordinary project event for characters. */
  notify(docId: string): Promise<void>;
}
export interface WikiCodec<State extends WikiCodecState, Lease> {
  initialize(workspaceId: string, docId: string, generation: string, body: string, lease: Lease): Promise<{ state: State; replicaId: number }>;
  enroll(state: State, actorId: string, replicaId: number, canWrite: boolean): State;
  fingerprint(envelope: WikiTextEnvelope, bytes: Uint8Array): string;
  validate(state: State, envelope: WikiTextEnvelope, bytes: Uint8Array, lease: Lease): Promise<
    { ok: false; code: string } | { ok: true; state: State; replay: boolean; receipt: { semanticNoop: boolean } }>;
  stateVector(state: State): string;
  prepareRead(state: State, lease: Lease): void;
  validateCursor(state: State, cursor: LiveCursor): void;
}
/** All ports share the one caller-owned SQL transaction; the lease is reserved before that transaction's first await. */
export interface WikiPorts<State extends WikiCodecState, Lease> {
  native: DocPorts; session: WikiSession; rows: WikiRows<State>; codec: WikiCodec<State, Lease>;
}
