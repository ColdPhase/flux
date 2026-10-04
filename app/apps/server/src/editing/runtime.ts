import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { emptyRoom, enroll, fingerprint, stateCharge, Refusal } from './codec/codec.mjs';
import { CodecPool } from './codec/worker-pool.mjs';
import type { CodecEnvelope, CodecState } from './codec/types.js';
import { EditingAdmission } from './admission.js';
import type { AdmissionLease } from './codec/admission-budget.mjs';

// A fresh one-root/one-string update: UTF-8 is at most four bytes per UTF-16 unit, plus a conservative public framing bound.
export const NATIVE_CHECKPOINT_BYTES = 400_256;

/** Only the typed server composition may call this codec; no model registry or client state enters SQL authority. */
export function editingRuntime() {
  const pool = new CodecPool(); const admissionQueue = new EditingAdmission(pool.budget);
  return {
    fingerprint,
    get externalInputBytes(){return pool.budget.bytes;},
    get admissionQueued(){return admissionQueue.queued;},
    get codecLeases(){return pool.budget.leases.size;},
    get codecWaiting(){return pool.waiting.length;},
    get codecActive(){return pool.active;},
    admit: (bytes: Uint8Array, metadataBytes: number, maximumInputBytes?: number) => admissionQueue.reserve(bytes, metadataBytes, maximumInputBytes),
    prepareRead: (state: CodecState, lease: AdmissionLease) => pool.budget.bind(lease, state),
    stateCharge,
    enroll,
    /** Called before any SQL/intent await. A controller keeps refused input in its charged assembly. */
    reserve: (bytes: Uint8Array, maximumInputBytes?: number) => pool.budget.reservePending(bytes, maximumInputBytes),
    release: (lease: AdmissionLease) => pool.budget.release(lease),
    onCapacity: (callback: () => void) => pool.budget.onCapacity(callback),
    async initialize(workspaceId: string, docId: string, generation: string, body: string, admission: AdmissionLease) {
      if (body.length > 100_000) throw new Error('Native body exceeds live initialization bound');
      const doc = new Y.Doc();
      try {
        // This bounded native body is already stored; all candidate decoding remains in the worker.
        const replicaId = doc.clientID; const actor = 'server-initialization';
        const state = enroll(emptyRoom(docId, generation, workspaceId), actor, replicaId, true);
        doc.getText('body').insert(0, body);
        const bytes = Y.encodeStateAsUpdate(doc);
        if (bytes.byteLength > NATIVE_CHECKPOINT_BYTES) throw new Refusal('NATIVE_CHECKPOINT_BOUND');
        // Initialization reserved the maximum encoded input before reading its saved body.
        pool.budget.replaceInput(admission, bytes); pool.budget.bind(admission, state);
        const result = await pool.run(state, { workspace: workspaceId, kind: 'wiki', room: docId,
          generation, actor, operation: 'text', uuid: randomUUID(), replica: replicaId, parameters: null }, bytes, { admission });
        if (!result.ok) throw new Error(`Native live initialization refused: ${result.code}`);
        if (result.state.body !== body) throw new Error('Native live initialization changed the saved body');
        // The server-owned baseline is sequence zero, not a user contribution or retry receipt.
        const baseline: CodecState = { ...result.state, sequence: 0,
          nodes: result.state.nodes.map((node) => ({ ...node, admittedSequence: 0 })),
          deleted: result.state.deleted.map((range) => ({ ...range, admittedSequence: 0 })), receipts: {}, journal: [] };
        return { state: baseline, replicaId };
      } finally { doc.destroy(); }
    },
    validate(state: CodecState, envelope: CodecEnvelope, bytes: Uint8Array, admission: AdmissionLease) {
      pool.budget.bind(admission, state);
      return pool.run(state, envelope, bytes, { canWrite: true, admission });
    },
    stateVector(state: CodecState) {
      return Buffer.from(Y.encodeStateVectorFromUpdate(Buffer.from(state.checkpoint, 'base64'))).toString('base64');
    },
    validateCursor(state: CodecState, cursor: { anchor: string; head: string }) {
      if (!cursor || Object.keys(cursor).some((key) => key !== 'anchor' && key !== 'head')) throw new Refusal('INVALID_CURSOR');
      for (const encoded of [cursor.anchor, cursor.head]) {
        if (typeof encoded !== 'string' || encoded.length > 344 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Refusal('INVALID_CURSOR');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.byteLength > 256 || bytes.toString('base64') !== encoded) throw new Refusal('INVALID_CURSOR');
        let relative: Y.RelativePosition;
        try { relative = Y.decodeRelativePosition(bytes); } catch { throw new Refusal('INVALID_CURSOR'); }
        if (relative.type !== null || (relative.item ? relative.tname !== null : relative.tname !== 'body') || !Number.isSafeInteger(relative.assoc) || Math.abs(relative.assoc) > 1) throw new Refusal('INVALID_CURSOR');
        if (!Buffer.from(Y.encodeRelativePosition(relative)).equals(bytes)) throw new Refusal('INVALID_CURSOR');
        if (relative.item && (!Number.isSafeInteger(relative.item.client) || !Number.isSafeInteger(relative.item.clock)
          || !state.nodes.some((node) => node.root === 'body' && node.client === relative.item!.client && relative.item!.clock >= node.clock && relative.item!.clock < node.clock + node.length))) throw new Refusal('INVALID_CURSOR');
      }
    },
    close: async () => { admissionQueue.close(); await pool.close(); },
  };
}
export type EditingRuntime = ReturnType<typeof editingRuntime>;
