import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { emptyRoom, enroll, fingerprint, stateCharge } from './codec/codec.mjs';
import { CodecPool } from './codec/worker-pool.mjs';
import type { CodecEnvelope, CodecState } from './codec/types.js';
import type { AdmissionLease } from './codec/admission-budget.mjs';

/** Only the typed server composition may call this codec; no model registry or client state enters SQL authority. */
export function editingRuntime() {
  const pool = new CodecPool();
  return {
    fingerprint,
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
    close: () => pool.close(),
  };
}
export type EditingRuntime = ReturnType<typeof editingRuntime>;
