import type { Doc, DocMention, SaveLiveDocCommand } from './docs.js';
import type { NamedPrincipal } from './work.js';
import type { Sketch, SketchDetail, Thought, ThoughtLink } from './sketch.js';

/** #228 integration seam. Routes remain disabled until the four accepted gates pass. */
export const EDITING_SOCKET_PATH = '/api/v1/editing';
/** The process's live map/wiki capability. Clients mount live editors only when it is `configured`;
 * otherwise maps and the wiki behave exactly as without #228 (#239 review). */
export const EDITING_CAPABILITIES_PATH = '/api/v1/live-editing/capabilities';
export type EditingCapability = 'configured' | 'unavailable';
export const liveDocPath = (id: string) => `/api/v1/docs/${id}/live`;
export const liveDocEnrollPath = (id: string) => `${liveDocPath(id)}/enroll`;
export const liveDocSavePath = (id: string) => `${liveDocPath(id)}/save`;
export const liveDocReceiptPath = (id: string, commandId: string) => `${liveDocPath(id)}/receipts/${commandId}`;
export const liveMapPath = (id: string) => `/api/v1/sketches/${id}/live`;
export const liveMapGesturePath = (id: string) => `${liveMapPath(id)}/gestures`;
export const liveMapUndoPath = (id: string) => `${liveMapPath(id)}/undo`;

export const EDITING_LIMITS = {
  frameBytes: 65_536, chunkBytes: 61_440, assemblyBytes: 8 * 1024 * 1024,
  chunks: 144, assemblyTimeoutMs: 10_000, outputWindowBytes: 1024 * 1024,
  bodyUnits: 100_000, selectedThoughts: 16, movedThoughts: 200,
} as const;

export interface LiveHead {
  workspaceId: string;
  resourceId: string;
  generation: string;
  sequence: number;
  hash: string;
}
export interface LiveDocBootstrap extends LiveHead {
  kind: 'wiki';
  savedVersion: number;
  savedSequence: number;
  body: string;
  html: string;
  mentions: DocMention[];
  /** Bounded public Yjs v1 update/state-vector, base64; never a private recovery draft. */
  checkpoint: string;
  stateVector: string;
  canWrite: boolean;
  actor: NamedPrincipal;
}
export interface LiveMapBootstrap extends LiveHead {
  kind: 'map';
  /** Native snapshot and this revision are read atomically under the room/material fence. */
  sketch: SketchDetail;
  canWrite: boolean;
  actor: NamedPrincipal;
}
export interface EnrollLiveDoc {
  generation: string;
  replicaId: number;
  /** Only the same surviving Y.Doc may renew its previously issued instance. */
  instanceId?: string;
}
export interface EnrolledLiveDoc {
  generation: string;
  replicaId: number;
  instanceId: string;
  expiresAt: string;
}

/** Immutable persistent intent; actor/scope are checked against server identity, never trusted from this input. */
export interface WikiTextEnvelope {
  workspace: string;
  kind: 'wiki';
  room: string;
  generation: string;
  actor: string;
  operation: 'text';
  uuid: string;
  replica: number;
  parameters: null;
}
/** Binary: four-byte big-endian UTF-8 JSON header length, header, then exact Yjs update chunk. */
export interface WikiTextChunk extends WikiTextEnvelope { index: number; count: number }
export interface LiveUpdateChunk {
  type: 'update';
  deliveryId: string;
  generation: string;
  sequence: number;
  hash: string;
  commandId: string;
  actor: NamedPrincipal;
  index: number;
  count: number;
}

/** Bounded binary UTF-8 JSON `{html, mentions}` for sanitized live readers, including the 100k boundary. */
export interface LivePreviewChunk {
  type: 'preview'; deliveryId: string; generation: string; sequence: number; hash: string; index: number; count: number;
}

export interface LiveCursor {
  /** Base64 public encoded Yjs relative positions; each is bounded and validated against the current head. */
  anchor: string;
  head: string;
}
export interface LiveMapGesture {
  gestureId: string;
  thoughts: { id: string; expectedVersion: number }[];
}
export interface LiveMapLease { gestureId: string; leaseId: string; generation: string; expiresAt: string }
/** One user step, reversed atomically in original reverse order with current poststate/dependency guards. */
export interface UndoLiveMap { clientCommandId: string; originalCommandIds: string[] }
export interface UndoneLiveMap { commandId: string; delta: LiveMapDelta }
export interface LiveMapPosition { id: string; x: number; y: number; width?: number; height?: number }
/** Server-built postimages/tombstones of one committed native operation, never a client-supplied patch. */
export interface LiveMapDelta {
  generation: string;
  sequence: number;
  commandId: string;
  actor: NamedPrincipal;
  sketch?: Sketch;
  thoughts: Thought[];
  removedThoughts: { id: string; version: number }[];
  links: ThoughtLink[];
  removedLinks: string[];
  /** Clears only previews affected by this commit, including a superseded non-drag native edit. */
  clearedLeaseIds: string[];
}
/** Same bounded binary framing/window as text, carrying UTF-8 JSON of the complete authorized delta. */
export interface LiveMapDeltaChunk {
  type: 'map-delta'; deliveryId: string; generation: string; sequence: number; commandId: string; index: number; count: number;
}
export type EditingClientMessage =
  | { type: 'subscribe'; generation: string; afterSequence: number }
  | { type: 'received'; deliveryId: string; index: number }
  | { type: 'cursor'; generation: string; cursor: LiveCursor | null }
  | { type: 'map-presence'; generation: string; selected: string[]; cursor: { x: number; y: number } | null }
  | { type: 'map-move'; generation: string; gestureId: string; leaseId: string; sequence: number; positions: LiveMapPosition[] }
  | { type: 'map-cancel'; generation: string; gestureId: string; leaseId: string };

export interface LiveReceipt extends LiveHead {
  commandId: string;
  operation: 'text' | 'save';
  fingerprint: string;
  /** Exact known duplicates receive a receipt but do not acquire a new contribution sequence. */
  changed: boolean;
  savedDoc?: Doc;
}
export type EditingServerMessage =
  | ({ type: 'head'; kind: 'wiki' | 'map'; canWrite: boolean; actor: NamedPrincipal; savedVersion?: number } & LiveHead)
  | ({ type: 'ack' } & LiveReceipt)
  | { type: 'preview'; generation: string; sequence: number; hash: string; html: string; mentions: DocMention[] }
  | { type: 'presence'; generation: string; connectionId: string; actor: NamedPrincipal; cursor: LiveCursor | null; expiresAt: string }
  | { type: 'map-presence'; generation: string; connectionId: string; actor: NamedPrincipal; selected: string[]; cursor: { x: number; y: number } | null; expiresAt: string }
  | { type: 'map-move'; generation: string; connectionId: string; actor: NamedPrincipal; gestureId: string; leaseId: string; sequence: number; positions: LiveMapPosition[]; expiresAt: string }
  | { type: 'map-clear'; generation: string; leaseId: string }
  | ({ type: 'map-delta' } & LiveMapDelta)
  | { type: 'saved'; generation: string; sequence: number; hash: string; savedVersion: number; savedSequence: number }
  | { type: 'resync'; reason: 'gap' | 'generation' | 'backpressure'; generation: string }
  | { type: 'error'; code: string; commandId?: string; outcome: 'refused' | 'unknown'; retryable: boolean }
  | { type: 'revoked' };

export interface SaveSharedDoc extends SaveLiveDocCommand {
  clientCommandId: string;
  expectedVersion: number;
}
