import { liveWiki, ServiceUnavailableError, type WikiIdentity, type WikiPorts } from '@flux/core';
import { editingSessionRows, editingTransactions, liveEditingRows, type createDatabase, type DbExecutor } from '@flux/db';
import type { LiveCursor, LiveReceipt, SaveSharedDoc, WikiTextEnvelope } from '@flux/contracts';
import { docPorts } from '../docs/adapters.js';
import { UnauthenticatedError, type SessionContext } from '../identity/session.js';
import type { AdmissionLease } from './codec/admission-budget.mjs';
import type { CodecState } from './codec/types.js';
import { editingContextCharge } from './context-charge.js';
import { editingRuntime, NATIVE_CHECKPOINT_BYTES } from './runtime.js';

const EMPTY = new Uint8Array(0);
/** Production composition. The caller receives data only through the held current authority fence. */
export function wikiAuthority(database: { pool: Pick<ReturnType<typeof createDatabase>['pool'], 'connect'> }, runtime = editingRuntime(),
  boundary: { beforeHandoff?: () => Promise<void> } = {}) {
  const transactions = editingTransactions(database.pool); const active = new Set<Promise<unknown>>();
  const identity = (session: SessionContext): WikiIdentity => ({ sessionId: session.sessionId, actorId: session.principal.id });
  function stored(value: Record<string, unknown>): CodecState {
    if (value.kind !== 'wiki' || typeof value.workspace !== 'string' || typeof value.room !== 'string' || typeof value.generation !== 'string'
      || typeof value.body !== 'string' || value.body.length > 100_000 || !Number.isSafeInteger(value.sequence)
      || typeof value.checkpoint !== 'string' || !Array.isArray(value.nodes) || !Array.isArray(value.deleted) || !Array.isArray(value.journal)
      || !Array.isArray(value.splits) || !value.enrollments || !value.receipts) throw new Error('Invalid stored live codec');
    const state = value as CodecState;
    if (runtime.stateCharge(state) > 8 * 1024 * 1024) throw new ServiceUnavailableError('This room reached its bounded codec capacity', 'EDITING_ROOM_CAPACITY');
    return state;
  }
  function ports(db: DbExecutor): WikiPorts<CodecState, AdmissionLease> {
    const sessions = editingSessionRows(db);
    return { native: docPorts(db), rows: liveEditingRows(db, stored), codec: runtime,
      session: { async lock(who) { const actor = await sessions.lock(who); if (!actor) throw new UnauthenticatedError(); return actor; },
        async assertCurrent(who) { if (!await sessions.current(who)) throw new UnauthenticatedError(); } } };
  }
  async function run<T>(session: SessionContext, admission: AdmissionLease, action: (wiki: ReturnType<typeof liveWiki<CodecState, AdmissionLease>>, finalFence: () => Promise<void>) => Promise<T>) {
    try {
      const work = transactions.run(async (db) => {
        const adapters = ports(db); const result = await action(liveWiki(adapters), () => adapters.session.assertCurrent(identity(session)));
        await adapters.session.assertCurrent(identity(session));
        return result;
      });
      active.add(work);
      try { return await work; } finally { active.delete(work); }
    } finally { runtime.release(admission); }
  }
  return {
    identity, runtime,
    async bootstrap(session: SessionContext, docId: string) {
      // Initialization reserves the proved one-string encoded baseline BEFORE loading a body or waiting for SQL.
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId }), NATIVE_CHECKPOINT_BYTES);
      return run(session, admission, (wiki) => wiki.bootstrap(identity(session), docId, admission));
    },
    async enroll(session: SessionContext, docId: string, command: Parameters<ReturnType<typeof liveWiki<CodecState, AdmissionLease>>['enroll']>[2]) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, command }));
      return run(session, admission, (wiki) => wiki.enroll(identity(session), docId, command));
    },
    /** Completed bytes remain charged in assembly until this synchronous reservation succeeds. */
    reserve: runtime.reserve,
    async submit(session: SessionContext, docId: string, envelope: WikiTextEnvelope, bytes: Uint8Array, admission: AdmissionLease) {
      return run(session, admission, (wiki) => wiki.submit(identity(session), docId, envelope, bytes, admission));
    },
    async cursor(session: SessionContext, docId: string, generation: string, connectionId: string, cursor: LiveCursor | null) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, generation, connectionId, cursor }));
      return run(session, admission, (wiki) => wiki.cursor(identity(session), docId, generation, connectionId, cursor));
    },
    async save(session: SessionContext, docId: string, command: SaveSharedDoc) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, command }));
      return run(session, admission, (wiki) => wiki.save(identity(session), docId, command));
    },
    async receipt(session: SessionContext, docId: string, commandId: string) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, commandId }));
      return run(session, admission, (wiki) => wiki.receipt(identity(session), docId, commandId));
    },
    /** All preparation and the synchronous socket handoff run under current SQL session/resource locks. */
    async deliver(session: SessionContext, docId: string, generation: string, afterSequence: number,
      handoff: (result: Awaited<ReturnType<ReturnType<typeof liveWiki<CodecState, AdmissionLease>>['readConfirmed']>>) => void,
      view: { previewAfterSequence?: number; includeContent?: boolean } = {}) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, generation, afterSequence, view }));
      return run(session, admission, async (wiki, finalFence) => {
        const result = await wiki.readConfirmed(identity(session), docId, generation, afterSequence, view);
        await boundary.beforeHandoff?.(); await finalFence(); handoff(result);
      });
    },
    async handoff(session: SessionContext, docId: string, send: () => void) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId }));
      return run(session, admission, async (wiki, finalFence) => { await wiki.authorizeHandoff(identity(session), docId); await boundary.beforeHandoff?.(); await finalFence(); send(); });
    },
    async deliverReceipt(session: SessionContext, docId: string, commandId: string, handoff: (receipt: LiveReceipt | null) => void) {
      const admission = await runtime.admit(EMPTY, editingContextCharge({ session, docId, commandId }));
      return run(session, admission, async (wiki, finalFence) => { const receipt = await wiki.receipt(identity(session), docId, commandId); await boundary.beforeHandoff?.(); await finalFence(); handoff(receipt); });
    },
    close: async () => { await runtime.close(); await Promise.allSettled([...active]); },
  };
}
export type WikiAuthority = ReturnType<typeof wikiAuthority>;
