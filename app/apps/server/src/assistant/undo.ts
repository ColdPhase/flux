import { createHash, randomUUID } from 'node:crypto';
import { assistantChangeRows, type AssistantChangeRow, type DbExecutor } from '@flux/db';
import { DomainError, restorableFields, type Database, type Principal, type UndoRecord } from '@flux/core';
import { nativeMapRoomExists, prepareNativeMap } from '../editing/native-map-journal.js';
import { nativeCapacityRefusal, nativeSketchInEventSession } from '../sketches/adapters.js';
import { nativeDocsInEventSession } from '../docs/adapters.js';
import { nativeWorkInEventSession } from '../work/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';

// Undo of one applied assistant change (F-027 AST-6, A4 #404): a compensating, versioned write by the owner
// through the same native commands a person uses, only where the fields the assistant changed are untouched
// since. Anything else changes nothing and says "Changed since. Open it". Nothing is rolled back in place: the
// earlier text or value becomes a new version, so the history keeps both.

export interface UndoResult { done: boolean; message: string | null }
export const CHANGED_SINCE = 'Changed since. Open it';
export const NOT_UNDOABLE = 'This one can’t be undone';
class Since extends Error { constructor(readonly message: string = CHANGED_SINCE) { super(message); } }

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Restores one change inside one transaction; a refusal rolls the whole transaction back and writes nothing. */
export async function undoChange(db: Database, row: AssistantChangeRow, owner: Principal, ownerName: string): Promise<UndoResult> {
  const record = (row.receipt as { undo?: UndoRecord } | null)?.undo;
  if (!record || (row.state !== 'applied' && row.state !== 'applied_after_wait')) return { done: false, message: NOT_UNDOABLE };
  const releases = new Set<() => void>();
  try {
    // A map with a live room takes the live preparation first, as the assistant's own map change did.
    const sketchId = await db.transaction(async (tx) => {
      const rows = assistantChangeRows(tx as DbExecutor);
      if (row.operation.startsWith('map.thought') && row.objectId) return (await rows.thoughts([row.objectId]))[0]?.sketchId ?? null;
      if (row.operation === 'map.link.create' && row.objectId) return (await rows.link(row.objectId))?.sketchId ?? null;
      if (row.operation === 'map.positions.update' && record.plan.kind === 'positions') return (await rows.thoughts([record.plan.moves[0]!.id]))[0]?.sketchId ?? null;
      return null;
    });
    const live = sketchId !== null && await nativeMapRoomExists(db as DbExecutor, sketchId);
    if (live) releases.add(await prepareNativeMap({ operation: 'assistant.undo', objectId: sketchId, payload: { changeId: row.id } }).catch((error: unknown) => { throw nativeCapacityRefusal(error); }));
    await db.transaction(async (tx) => {
      const rows = assistantChangeRows(tx as DbExecutor);
      const session = transactionEventSession(tx);
      const locked = await rows.lock(row.id);
      if (!locked || (locked.state !== 'applied' && locked.state !== 'applied_after_wait')) throw new Since('Already undone');
      const work = nativeWorkInEventSession(tx, session);
      const docs = nativeDocsInEventSession(tx, session);
      const maps = nativeSketchInEventSession(tx, session, { prepared: live, commandId: randomUUID(), operation: 'native-owner:assistant-undo',
        fingerprint: sha(`undo:${row.id}`), retainUntil: (release) => releases.add(release) });
      const { plan } = record;
      const id = row.objectId;
      const reason = `Undo: ${ownerName} undid their assistant's change`;
      const gone = (value: unknown) => { if (!value) throw new Since('Already gone'); return value as NonNullable<typeof value>; };
      if (!id && plan.kind !== 'positions') throw new Since(NOT_UNDOABLE);
      switch (row.operation) {
        case 'work.create': {
          const current = gone(await rows.work(id!)) as { version: number };
          await work.undoTaskCreation(owner, id!, { clientCommandId: randomUUID(), expectedVersion: current.version });
          break;
        }
        case 'work.update': {
          if (plan.kind !== 'fields') throw new Since(NOT_UNDOABLE);
          const current = gone(await rows.work(id!)) as Record<string, unknown> & { version: number };
          const { restore, changedSince } = restorableFields(plan.fields, current);
          if (changedSince.length) throw new Since();
          await work.updateWork(owner, id!, restore, current.version);
          break;
        }
        case 'doc.create': {
          const current = gone(await rows.doc(id!)) as { version: number; state: string | null };
          if (row.afterVersion !== null && current.version !== row.afterVersion) throw new Since();
          if (current.state !== 'draft') await docs.updateDoc(owner, id!, { state: 'draft', reason }, current.version);
          break;
        }
        case 'doc.update': {
          if (plan.kind !== 'doc' || !row.beforeVersion || !row.afterVersion) throw new Since(NOT_UNDOABLE);
          const [current, before, after] = [gone(await rows.doc(id!)) as Record<string, unknown> & { version: number },
            gone(await rows.docVersion(id!, row.beforeVersion)) as Record<string, unknown>, gone(await rows.docVersion(id!, row.afterVersion)) as Record<string, unknown>];
          const fields = Object.fromEntries(plan.fields.map((key) => [key, { before: before[key], after: after[key] }]));
          const { restore, changedSince } = restorableFields(fields, current);
          if (changedSince.length) throw new Since();
          await docs.updateDoc(owner, id!, { ...restore, reason }, current.version);
          break;
        }
        case 'map.thought.create': {
          const [thought] = await rows.thoughts([id!]);
          gone(thought);
          if (row.afterVersion !== null && thought!.version !== row.afterVersion) throw new Since();
          await maps.removeThought(owner, thought!.sketchId, id!, thought!.version);
          break;
        }
        case 'map.link.create': {
          const link = gone(await rows.link(id!)) as { sketchId: string };
          await maps.removeLink(owner, link.sketchId, id!);
          break;
        }
        case 'map.thought.update': {
          if (plan.kind !== 'fields') throw new Since(NOT_UNDOABLE);
          const [thought] = await rows.thoughts([id!]);
          gone(thought);
          const { restore, changedSince } = restorableFields(plan.fields, thought as unknown as Record<string, unknown>);
          if (changedSince.length) throw new Since();
          await maps.updateThought(owner, thought!.sketchId, id!, { ...restore, expectedVersion: thought!.version });
          break;
        }
        case 'map.positions.update': {
          if (plan.kind !== 'positions') throw new Since(NOT_UNDOABLE);
          const thoughts = await rows.thoughts(plan.moves.map((move) => move.id));
          const moves = plan.moves.map((move) => {
            const current = thoughts.find((item) => item.id === move.id);
            if (!current || current.x !== move.after.x || current.y !== move.after.y) throw new Since();
            return { id: move.id, x: move.before.x, y: move.before.y, expectedVersion: current.version };
          });
          await maps.moveThoughts(owner, thoughts[0]!.sketchId, { moves });
          break;
        }
        default: throw new Since(NOT_UNDOABLE);
      }
      const decidedAt = new Date();
      await rows.update(row.id, { state: 'undone', decidedBy: owner.id, decidedAt, receipt: { ...(locked.receipt ?? {}), undone: { by: owner.id, at: decidedAt.toISOString() } } as never });
      await session.flushEvents();
    });
    return { done: true, message: row.operation === 'doc.create' ? 'Moved to your drafts' : null };
  } catch (error) {
    if (error instanceof Since) return { done: false, message: error.message };
    // A domain refusal (a task already in use, a page someone else holds, a thought gone) is the same truth: it changed.
    if (error instanceof DomainError || (error instanceof Error && 'status' in error)) return { done: false, message: CHANGED_SINCE };
    throw error;
  } finally { for (const release of releases) release(); }
}
