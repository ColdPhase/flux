import { EDITING_LIMITS, type LiveMapBootstrap, type LiveMapGesture, type LiveMapLease, type UndoLiveMap, type UndoneLiveMap } from '@flux/contracts';
import { ServiceUnavailableError, type LiveMapBackend, type MapCancel, type MapConfirmed, type MapIdentity, type MapMove, type MapPresence } from '@flux/core';
import type { SessionContext } from '../identity/session.js';
import { editingMapContextCharge, editingMapResultCharge } from './context-charge.js';
import { EditingOutputBudget, EditingOutputError } from './output.js';

type Reservation = ReturnType<EditingOutputBudget['lease']>;
interface Waiter { lease: Reservation; inputBytes: number; worstResult: number; timer: NodeJS.Timeout; grant: () => void; reject: (error: unknown) => void }
export interface MapPreparation {
  /** Protected JSON text; EditingOutput reserves its wire backing before allocating it. */
  encode(value: unknown): string;
}
const LARGE_RESULT = 24 * 1024 * 1024;
const SMALL_RESULT = 2 * 1024 * 1024;
const capacity = () => new ServiceUnavailableError('The finite live map capacity is busy', 'EDITING_MAP_CAPACITY');

/** Count the exact JSON wire/text size without first allocating an escaped copy. */
function jsonSize(value: unknown) {
  let bytes = 0, units = 0;
  const add = (wire: number, text = wire) => {
    bytes += wire; units += text;
    if (bytes > EDITING_LIMITS.assemblyBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
  };
  function string(text: string) {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const point = text.charCodeAt(i);
      if (point === 34 || point === 92 || [8, 9, 10, 12, 13].includes(point)) add(2);
      else if (point < 32) add(6);
      else if (point < 128) add(1);
      else if (point < 2048) add(2, 1);
      else if (point >= 0xd800 && point <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4, 2); i++; } else add(6);
      } else if (point >= 0xdc00 && point <= 0xdfff) add(6);
      else add(3, 1);
    }
  }
  function visit(child: unknown) {
    if (child === null || child === undefined) add(4);
    else if (typeof child === 'string') string(child);
    else if (typeof child === 'boolean') add(child ? 4 : 5);
    else if (typeof child === 'number') add(Number.isFinite(child) ? String(child).length : 4);
    else if (child instanceof Date) { if (Number.isFinite(child.getTime())) string(child.toISOString()); else add(4); }
    else if (Array.isArray(child)) {
      add(2); for (let i = 0; i < child.length; i++) { if (i) add(1); visit(child[i]); }
    } else if (child && typeof child === 'object' && Object.getPrototypeOf(child) === Object.prototype) {
      add(2); let first = true;
      for (const [key, nested] of Object.entries(child)) {
        if (nested === undefined) continue;
        if (!first) add(1); first = false; string(key); add(1); visit(nested);
      }
    } else throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
  }
  visit(value); return { bytes, textBytes: units * 2 };
}

/** A single injected API-wide budget covers input, queue, SQL preparation and owned output. */
export function mapAuthority(backend: LiveMapBackend, outputBudget: EditingOutputBudget) {
  const waiting: Waiter[] = [];
  const active = new Set<Promise<unknown>>();
  const operations = new Set<Promise<void>>();
  let running = 0, closing = false, pumping = false;
  const identity = (session: SessionContext): MapIdentity => ({ sessionId: session.sessionId, actorId: session.principal.id });
  function pump() {
    if (pumping || closing) return;
    pumping = true;
    try {
      while (running < 4 && waiting.length) {
        const item = waiting[0]!;
        try { item.lease.resize(item.inputBytes + item.worstResult); }
        catch (error) {
          if (error instanceof EditingOutputError && error.code === 'EDITING_OUTPUT_CAPACITY') break;
          waiting.shift(); clearTimeout(item.timer); item.lease.release(); item.reject(error); continue;
        }
        waiting.shift(); clearTimeout(item.timer); running++; item.grant();
      }
    } finally { pumping = false; }
  }
  const unsubscribe = outputBudget.onCapacity(pump);
  function admit(context: unknown, rawBytes: number, worstResult: number) {
    if (closing || waiting.length >= 8 || !Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > EDITING_LIMITS.frameBytes) throw capacity();
    // Own the complete parsed continuation and raw frame allowance BEFORE queue/SQL await.
    const inputBytes = rawBytes + editingMapContextCharge(context);
    const lease = outputBudget.lease(inputBytes);
    return { lease, inputBytes, ready: new Promise<void>((grant, reject) => {
      const item: Waiter = { lease, inputBytes, worstResult, grant, reject, timer: setTimeout(() => {
        const index = waiting.indexOf(item); if (index < 0) return;
        waiting.splice(index, 1); lease.release(); reject(capacity()); pump();
      }, 10_000) };
      item.timer.unref(); waiting.push(item); pump();
    }) };
  }
  async function run<T>(context: unknown, rawBytes: number, worstResult: number, action: (lease: Reservation, inputBytes: number) => Promise<T>): Promise<T> {
    const admission = admit(context, rawBytes, worstResult);
    let finish = () => {};
    const operation = new Promise<void>((resolve) => { finish = resolve; }); operations.add(operation);
    let acquired = false;
    try {
      await admission.ready; acquired = true;
      if (closing) throw capacity();
      const work = action(admission.lease, admission.inputBytes); active.add(work);
      try { return await work; } finally { active.delete(work); }
    } finally {
      if (acquired) running--;
      try { admission.lease.release(); pump(); }
      finally { operations.delete(operation); finish(); }
    }
  }
  function protectedResult<T>(lease: Reservation, inputBytes: number, result: T, handoff: (result: T, preparation: MapPreparation) => void) {
    const sourceBytes = editingMapResultCharge(result);
    let textBytes = 0, encoded = false;
    const preparation: MapPreparation = {
      encode(value) {
        if (encoded) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
        encoded = true;
        // The protected result, or its delta subtree, is the only charged source.
        if (value !== result && !(result && typeof result === 'object' && 'delta' in result && value === result.delta)) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
        // Validate and reserve the complete escaped copy BEFORE stringify.
        // The separately owned wire backing belongs
        // to EditingOutput.sendJSONPayload, so there is no uncharged Buffer gap.
        const size = jsonSize(value);
        lease.resize(inputBytes + sourceBytes + size.textBytes);
        textBytes = size.textBytes;
        const text = JSON.stringify(value);
        if (text === undefined || Buffer.byteLength(text) !== size.bytes || text.length * 2 !== textBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
        return text;
      },
    };
    try { handoff(result, preparation); }
    finally {
      // Backend may still retain this result across its SQL COMMIT await. Keep
      // source/text charged until that operation actually settles, not just until
      // a socket callback takes ownership of its separate payload copy.
      lease.resize(inputBytes + sourceBytes + textBytes);
    }
  }
  return {
    identity,
    bootstrap(session: SessionContext, sketchId: string, handoff: (head: LiveMapBootstrap, preparation: MapPreparation) => void) {
      return run({ session, sketchId }, 0, LARGE_RESULT, (lease, bytes) => backend.bootstrap(identity(session), sketchId,
        (head) => protectedResult(lease, bytes, head, handoff)));
    },
    authorize(session: SessionContext, sketchId: string, handoff: () => void) {
      return run({ session, sketchId }, 0, SMALL_RESULT, () => backend.authorize(identity(session), sketchId, handoff));
    },
    acquire(session: SessionContext, sketchId: string, gesture: LiveMapGesture): Promise<LiveMapLease> {
      return run({ session, sketchId, gesture }, 0, SMALL_RESULT, () => backend.acquire(identity(session), sketchId, gesture));
    },
    move(session: SessionContext, sketchId: string, connectionId: string, command: MapMove, rawBytes = 0) {
      return run({ session, sketchId, connectionId, command }, rawBytes, SMALL_RESULT, () => backend.move(identity(session), sketchId, connectionId, command));
    },
    cancel(session: SessionContext, sketchId: string, connectionId: string, command: MapCancel, rawBytes = 0) {
      return run({ session, sketchId, connectionId, command }, rawBytes, SMALL_RESULT, () => backend.cancel(identity(session), sketchId, connectionId, command));
    },
    presence(session: SessionContext, sketchId: string, connectionId: string, command: MapPresence, rawBytes = 0) {
      return run({ session, sketchId, connectionId, command }, rawBytes, SMALL_RESULT, () => backend.presence(identity(session), sketchId, connectionId, command));
    },
    undo(session: SessionContext, sketchId: string, command: UndoLiveMap): Promise<string> {
      return run({ session, sketchId, command }, 0, LARGE_RESULT, () => backend.undo(identity(session), sketchId, command));
    },
    deliverUndo(session: SessionContext, sketchId: string, commandId: string, handoff: (receipt: UndoneLiveMap, preparation: MapPreparation) => void) {
      return run({ session, sketchId, commandId }, 0, LARGE_RESULT, (lease, bytes) => backend.deliverUndo(identity(session), sketchId, commandId,
        (receipt) => protectedResult(lease, bytes, receipt, handoff)));
    },
    deliver(session: SessionContext, sketchId: string, generation: string, afterSequence: number,
      handoff: (result: MapConfirmed, preparation: MapPreparation) => void, options: { includeDelta?: boolean } = {}) {
      return run({ session, sketchId, generation, afterSequence, options }, 0, LARGE_RESULT, (lease, bytes) => backend.deliver(identity(session), sketchId, generation, afterSequence,
        (result) => protectedResult(lease, bytes, result, handoff), options));
    },
    disconnect(session: SessionContext, sketchId: string, connectionId: string) {
      return run({ session, sketchId, connectionId }, 0, SMALL_RESULT, () => backend.disconnect(identity(session), sketchId, connectionId));
    },
    async close() {
      closing = true; unsubscribe();
      for (const item of waiting.splice(0)) { clearTimeout(item.timer); item.lease.release(); item.reject(capacity()); }
      // Includes granted continuations which have not resumed their microtask,
      // without polling/spinning while bounded SQL work is still settling.
      await Promise.allSettled([...operations]); await Promise.allSettled([...active]); await backend.close();
    },
    get queued() { return waiting.length; }, get inFlight() { return running; },
  };
}
export type MapAuthority = ReturnType<typeof mapAuthority>;
