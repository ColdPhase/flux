import { liveWiki, ServiceUnavailableError, type WikiHead, type WikiIdentity, type WikiPorts, type WikiRows } from '@flux/core';
import { editingSessionRows, editingTransactions, liveEditingRows, type createDatabase, type DbExecutor } from '@flux/db';
import type { LiveCursor, LiveReceipt, SaveSharedDoc, WikiTextEnvelope } from '@flux/contracts';
import { docPorts } from '../docs/adapters.js';
import { UnauthenticatedError, type SessionContext } from '../identity/session.js';
import type { AdmissionLease } from './codec/admission-budget.mjs';
import type { CodecState } from './codec/types.js';
import { editingContextCharge } from './context-charge.js';
import { editingRuntime, NATIVE_CHECKPOINT_BYTES } from './runtime.js';
import { apiEditingOutputBudget,type EditingOutputBudget } from './output.js';
import { editingResourcesChanged } from './resource-observation.js';
import { DecodedRooms } from './rooms.js';

const EMPTY = new Uint8Array(0);
/** A text commit rewrites the complete state as its snapshot at most once in this many updates;
 * between snapshots it only appends to the update log (founder direction 2026-10-09, B1). */
export const WIKI_SNAPSHOT_INTERVAL = 64;
type RoomHead = WikiHead<CodecState> & { snapshotSequence: number };
interface Committed { generation: string; revision: number; state: CodecState }
/** Production composition. The caller receives data only through the held current authority fence. */
export function wikiAuthority(database: { pool: Pick<ReturnType<typeof createDatabase>['pool'], 'connect'> }, runtime = editingRuntime(),
  boundary: { beforeHandoff?: () => Promise<void>;outputBudget?:EditingOutputBudget;rooms?:DecodedRooms } = {}) {
  const rooms = boundary.rooms ?? new DecodedRooms();
  const outputBudget=boundary.outputBudget??apiEditingOutputBudget;
  const transactions = editingTransactions(database.pool); const active = new Set<Promise<unknown>>();
  const identity = (session: SessionContext): WikiIdentity => ({ sessionId: session.sessionId, actorId: session.principal.id });
  function stored(value: Record<string, unknown>): CodecState {
    if (value.kind !== 'wiki' || typeof value.workspace !== 'string' || typeof value.room !== 'string' || typeof value.generation !== 'string'
      || typeof value.body !== 'string' || value.body.length > 100_000 || !Number.isSafeInteger(value.sequence)
      || typeof value.checkpoint !== 'string' || !Array.isArray(value.nodes) || !Array.isArray(value.deleted)
      || !Array.isArray(value.splits) || !value.enrollments || typeof value.enrollments !== 'object') throw new Error('Invalid stored live codec');
    // States written before 0084 also carried receipts and a journal; both live in the immutable log rows.
    const state = { ...value } as CodecState & { receipts?: unknown; journal?: unknown };
    delete state.receipts; delete state.journal;
    if (runtime.stateCharge(state) > 8 * 1024 * 1024) throw new ServiceUnavailableError('This room reached its bounded codec capacity', 'EDITING_ROOM_CAPACITY');
    return state;
  }
  /**
   * The rows with the room state at the head: the decoded room of this process when it is at the
   * locked head's revision; otherwise that room plus the commits logged since it (only commits
   * changed the revision), or the stored snapshot plus every update logged after it. The rebuilt
   * state must agree with the head's body. Committed states enter the decoded rooms only after
   * their transaction commits (`committed`); a state read under the lock is committed already.
   */
  function roomRows(db: DbExecutor, committed: Map<string, Committed>): WikiRows<CodecState> {
    const rows = liveEditingRows(db, stored);
    return { ...rows,
      async lockHead(docId) {
        const head = await rows.lockHeadSummary(docId);
        if (!head) return null;
        const locked: Omit<RoomHead, 'codecState'> & { initialized?: boolean } = { ...head }; delete locked.initialized;
        if (!head.initialized) return { ...locked, codecState: null };
        const cached = rooms.get(docId, head.generation);
        if (cached && cached.revision === head.revision && cached.state.sequence === head.sequence) return { ...locked, codecState: cached.state };
        let base: CodecState;
        if (cached && cached.revision < head.revision && head.revision - cached.revision === head.sequence - cached.state.sequence) base = cached.state;
        else {
          const snapshot = await rows.snapshot(docId);
          if (!snapshot || snapshot.state.sequence !== snapshot.sequence || snapshot.sequence !== head.snapshotSequence) throw new Error('Invalid stored live snapshot');
          base = snapshot.state;
        }
        const log = await rows.log(docId, head.generation, base.sequence, head.sequence);
        if (log.length !== head.sequence - base.sequence || log.some((entry) => !entry.ledger)) throw new Error('The live update log cannot complete this room');
        const state = runtime.rebuild(base, log.map((entry) => ({ sequence: entry.sequence, bytes: new Uint8Array(entry.bytes),
          ledger: entry.ledger as unknown as Parameters<typeof runtime.rebuild>[1][number]['ledger'] })), head.body);
        rooms.put(docId, head.generation, head.revision, state);
        return { ...locked, codecState: state };
      },
      async insertHead(doc, generation, state) {
        // The same structural row the composition always passed (method bivariance before this wrapper).
        const head = await rows.insertHead(doc as Parameters<typeof rows.insertHead>[0], generation, state);
        committed.set(head.resourceId, { generation, revision: head.revision, state });
        return head;
      },
      async replaceState(head, state, bodyHash) {
        const revision = await rows.replaceState(head, state, bodyHash);
        committed.set(head.resourceId, { generation: head.generation, revision, state });
        return revision;
      },
      async commitText(head, next, bodyHash, envelope, bytes, fingerprint) {
        const { snapshotSequence } = head as RoomHead;
        const ledger = runtime.ledgerDelta(head.codecState!, next);
        const snapshot = next.sequence - snapshotSequence >= WIKI_SNAPSHOT_INTERVAL ? next : null;
        const revision = await rows.commitUpdate(head, { sequence: next.sequence, body: next.body, hash: bodyHash },
          { actor: envelope.actor, uuid: envelope.uuid, bytes, fingerprint, ledger: ledger as unknown as Record<string, unknown> }, snapshot);
        committed.set(head.resourceId, { generation: head.generation, revision, state: next });
      },
    };
  }
  function ports(db: DbExecutor, committed: Map<string, Committed>): WikiPorts<CodecState, AdmissionLease> {
    const sessions = editingSessionRows(db);
    return { native: docPorts(db), rows: roomRows(db, committed), codec: runtime,
      session: { async lock(who) { const actor = await sessions.lock(who); if (!actor) throw new UnauthenticatedError(); return actor; },
        async assertCurrent(who) { if (!await sessions.current(who)) throw new UnauthenticatedError(); } } };
  }
  async function run<T>(session: SessionContext, admission: AdmissionLease, action: (wiki: ReturnType<typeof liveWiki<CodecState, AdmissionLease>>, finalFence: () => Promise<void>,admission:AdmissionLease) => Promise<T>) {
    const committed = new Map<string, Committed>();
    try {
      const work = transactions.run(async (db) => {
        const adapters = ports(db, committed); const result = await action(liveWiki(adapters), () => adapters.session.assertCurrent(identity(session)),admission);
        await adapters.session.assertCurrent(identity(session));
        return result;
      });
      active.add(work);editingResourcesChanged();
      try {
        const result = await work;
        for (const [docId, room] of committed) rooms.put(docId, room.generation, room.revision, room.state);
        return result;
      } finally { active.delete(work);editingResourcesChanged(); }
    } finally { runtime.release(admission); }
  }
  async function admitted<T>(session:SessionContext,context:unknown,action:Parameters<typeof run<T>>[2],maximumInputBytes?:number) {
    // Full immutable continuation metadata belongs to the ONE output/context budget.
    // Codec32MiB still owns raw input/state/result; it does not hide a second metadata budget.
    const release=outputBudget.reserve(editingContextCharge(context));
    try {const admission=await runtime.admit(EMPTY,0,maximumInputBytes);return await run(session,admission,action);}
    finally {release();}
  }
  return {
    identity, runtime, rooms,
    get sqlActive(){return active.size;},
    async bootstrap(session: SessionContext, docId: string) {
      // Initialization reserves the proved one-string encoded baseline BEFORE loading a body or waiting for SQL.
      return admitted(session,{session,docId},(wiki,_finalFence,admission)=>wiki.bootstrap(identity(session),docId,admission),NATIVE_CHECKPOINT_BYTES);
    },
    async enroll(session: SessionContext, docId: string, command: Parameters<ReturnType<typeof liveWiki<CodecState, AdmissionLease>>['enroll']>[2]) {
      return admitted(session,{session,docId,command},wiki=>wiki.enroll(identity(session),docId,command));
    },
    /** Completed bytes remain charged in assembly until this synchronous reservation succeeds. */
    reserve: runtime.reserve,
    /** The controller's text input waits for its FIFO turn, so later reads and cursors cannot starve it. */
    queueInput: runtime.queueInput,
    async submit(session: SessionContext, docId: string, envelope: WikiTextEnvelope, bytes: Uint8Array, admission: AdmissionLease) {
      let release=()=>{};try {release=outputBudget.reserve(editingContextCharge({session,docId,envelope}));return await run(session,admission,wiki=>wiki.submit(identity(session),docId,envelope,bytes,admission));}
      finally {release();runtime.release(admission);}
    },
    async cursor(session: SessionContext, docId: string, generation: string, connectionId: string, cursor: LiveCursor | null) {
      return admitted(session,{session,docId,generation,connectionId,cursor},wiki=>wiki.cursor(identity(session),docId,generation,connectionId,cursor));
    },
    async save(session: SessionContext, docId: string, command: SaveSharedDoc) {
      return admitted(session,{session,docId,command},wiki=>wiki.save(identity(session),docId,command));
    },
    async receipt(session: SessionContext, docId: string, commandId: string) {
      return admitted(session,{session,docId,commandId},wiki=>wiki.receipt(identity(session),docId,commandId));
    },
    /** All preparation and the synchronous socket handoff run under current SQL session/resource locks. */
    async deliver(session: SessionContext, docId: string, generation: string, afterSequence: number,
      handoff: (result: Awaited<ReturnType<ReturnType<typeof liveWiki<CodecState, AdmissionLease>>['readConfirmed']>>) => void,
      view: { previewAfterSequence?: number; includeContent?: boolean } = {}) {
      return admitted(session,{session,docId,generation,afterSequence,view},async (wiki,finalFence)=>{
        const result = await wiki.readConfirmed(identity(session), docId, generation, afterSequence, view);
        await boundary.beforeHandoff?.(); await finalFence(); handoff(result);
      });
    },
    async handoff(session: SessionContext, docId: string, send: () => void) {
      return admitted(session,{session,docId},async (wiki,finalFence)=> { await wiki.authorizeHandoff(identity(session), docId); await boundary.beforeHandoff?.(); await finalFence(); send(); });
    },
    async deliverReceipt(session: SessionContext, docId: string, commandId: string, handoff: (receipt: LiveReceipt | null) => void) {
      return admitted(session,{session,docId,commandId},async (wiki,finalFence)=> { const receipt = await wiki.receipt(identity(session), docId, commandId); await boundary.beforeHandoff?.(); await finalFence(); handoff(receipt); });
    },
    close: async () => { await runtime.close(); await Promise.allSettled([...active]); },
  };
}
export type WikiAuthority = ReturnType<typeof wikiAuthority>;
