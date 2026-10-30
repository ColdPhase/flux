import { createHash, randomUUID } from 'node:crypto';
import { accessReader, assistantChangeRows, assistantRemovalRows, REMOVAL_REASONS, taskGraphRows, type AssistantChangeRow, type DbExecutor, type Removal } from '@flux/db';
import type { UpdateWorkCommand } from '@flux/contracts';
import { DomainError, requireWorkspaceAi, restorableFields, WorkspaceAiBlockedError, type Database, type Principal, type UndoRecord } from '@flux/core';
import { cancelOwnerAssistantUnitInTransaction } from '../co-work/assistant-units.js';
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
/** The changes whose Undo removes something no person can remove (#68): they follow the workspace AI lock (F-029), as the assistant's work does. */
export const REMOVAL_OPERATIONS: ReadonlySet<string> = new Set(['map.create', 'decision.propose', 'result.record', 'conversation.create', 'conversation.reply']);
export const requireAiOn = (db: Database, workspaceId: string) => db.transaction(async (tx) => { await requireWorkspaceAi(accessReader(tx as DbExecutor), workspaceId); });
class Since extends Error { constructor(readonly message: string = CHANGED_SINCE) { super(message); } }

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Restores one change inside one transaction; a refusal rolls the whole transaction back and writes nothing. `by` is whoever
 * undoes it, the owner or anyone who may edit the object, and every write is theirs, under their own rights (AST-6 "Undo").
 */
export async function undoChange(db: Database, row: AssistantChangeRow, by: Principal, byName: string, ownerName: string): Promise<UndoResult> {
  const owner = by;
  const record = (row.receipt as { undo?: UndoRecord } | null)?.undo;
  if (!record || (row.state !== 'applied' && row.state !== 'applied_after_wait')) return { done: false, message: NOT_UNDOABLE };
  const releases = new Set<() => void>();
  // A map someone has open in a live session is theirs now (the same check as the assistant's own map changes make).
  if (row.operation === 'map.create' && row.objectId && await nativeMapRoomExists(db as DbExecutor, row.objectId)) return { done: false, message: REMOVAL_REASONS.open };
  try {
    // A map with a live room takes the live preparation first, as the assistant's own map change did.
    const sketchId = await db.transaction(async (tx) => {
      const rows = assistantChangeRows(tx as DbExecutor);
      if (row.operation === 'map.rename' && row.objectId) return row.objectId;
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
      let removal: Removal | null = null;
      const id = row.objectId;
      // "Ada undid their assistant's change", or "Jonas undid Ada's assistant's change" when someone else takes it back.
      const reason = `Undo: ${byName} undid ${by.id === row.ownerUserId ? 'their' : `${ownerName}'s`} assistant's change`;
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
          const task = gone(await rows.work(id!)) as NonNullable<Awaited<ReturnType<typeof rows.work>>>;
          const current = { ...task, waitingFor: task.waitingForUserId } as unknown as Record<string, unknown> & { version: number };
          const { restore, changedSince } = restorableFields(plan.fields, current);
          if (changedSince.length) throw new Since();
          // `restore` puts back what was there: it posts no blocker again and tells nobody they are waited for again (#550).
          const { waitingFor, ...rest } = restore;
          await work.updateWork(owner, id!, { ...rest, ...(waitingFor === undefined ? {} : { waitingFor: waitingFor ? { kind: 'human' as const, id: String(waitingFor) } : null }),
            restore: true } as UpdateWorkCommand, current.version);
          break;
        }
        case 'map.rename': {
          if (plan.kind !== 'fields') throw new Since(NOT_UNDOABLE);
          const map = gone(await rows.map(id!)) as Record<string, unknown> & { version: number };
          const { restore, changedSince } = restorableFields(plan.fields, map);
          if (changedSince.length) throw new Since();
          await maps.rename(owner, id!, { title: String(restore.title), expectedVersion: map.version });
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
        case 'cowork.unit.create': {
          if (plan.kind !== 'handoff') throw new Since(NOT_UNDOABLE);
          const cancelled = await cancelOwnerAssistantUnitInTransaction(tx, by, { workspaceId: row.workspaceId, projectId: row.projectId,
            assistantConnectionId: String((row.receipt as { assistantConnectionId?: string } | null)?.assistantConnectionId ?? ''), taskId: plan.taskId,
            unitId: plan.unitId, creationVersion: plan.creationVersion });
          if (cancelled.result === 'started') throw new Since(`Your ${cancelled.recipient} already started. Open the task`);
          if (cancelled.result !== 'cancelled') throw new Since();
          break;
        }
        case 'map.create': case 'decision.propose': case 'result.record': case 'conversation.create': case 'conversation.reply': {
          // The four things no person can remove (#68 closeout): taken back only if the assistant made it in this run and nobody has used it.
          if (plan.kind !== 'removal' || !id) throw new Since(NOT_UNDOABLE);
          // F-029 and F-030: with AI off in the workspace (every encrypted one) nothing of the assistant's is touched; the policy row is held while it happens.
          await requireWorkspaceAi(accessReader(tx as DbExecutor), row.workspaceId, { lock: true });
          // A map's row before the graph, as every writer of its thoughts takes them (a thought written while this waits for the graph lock would
          // otherwise cross it); everything else takes the graph first.
          if (row.operation === 'map.create') await assistantRemovalRows(tx as DbExecutor).lockMap(id);
          // The project's task graph first, as every work path takes it (a reply in a task's discussion, a task or result being written, a
          // decision being accepted): then the object, its thread and the task are locked in their order, never the reverse, and what a
          // person cites at the same moment is either already committed when "used since" is read or waits for this Undo.
          await taskGraphRows(tx as DbExecutor).lockTaskGraphs([row.projectId]);
          const removals = assistantRemovalRows(tx as DbExecutor);
          const taken: Removal = row.operation === 'map.create' ? await removals.removeMap({ mapId: id, agentId: row.agentId, title: plan.title ?? '' })
            : row.operation === 'decision.propose' ? await removals.removeDecision({ decisionId: id, agentId: row.agentId, version: plan.version ?? null })
            : row.operation === 'result.record' ? await removals.removeResult({ resultId: id, agentId: row.agentId })
            : await removals.removeMessage({ messageId: id, agentId: row.agentId });
          if (!taken.ok) throw new Since(taken.why === 'foreign' ? NOT_UNDOABLE : taken.reason);
          // A result that finished a task: the task goes back to how it was, if it is still as the result left it.
          if (row.operation === 'result.record' && plan.finishes) {
            const task = await rows.work(plan.finishes.workId);
            if (!task || task.status !== 'done') throw new Since(REMOVAL_REASONS.taskChanged);
            await work.updateWork(owner, plan.finishes.workId, { status: plan.finishes.status, blocker: plan.finishes.blocker, restore: true } as UpdateWorkCommand, task.version);
          }
          await session.record(by, row.workspaceId, 'project.assistant_change_undone.v1', row.projectId,
            { changeId: row.id, objectType: row.objectType, objectId: id });
          removal = taken;
          break;
        }
        default: throw new Since(NOT_UNDOABLE);
      }
      const decidedAt = new Date();
      // What was taken back leaves nothing of its text behind in the log: a message loses its excerpt too (the hash and length stay).
      const scrubbed = removal?.ok ? { preparedCommand: null,
        ...(row.operation.startsWith('conversation.') ? { objectTitle: '', receipt: { ...(locked.receipt ?? {}), undo: { ...record, after: null } } } : {}) } : {};
      await rows.update(row.id, { state: 'undone', decidedBy: owner.id, decidedAt, ...scrubbed,
        receipt: { ...((scrubbed as { receipt?: Record<string, unknown> }).receipt ?? locked.receipt ?? {}), undone: { by: owner.id, at: decidedAt.toISOString(), ...(removal?.ok ? { removed: removal.snapshot } : {}) } } as never });
      await session.flushEvents();
    });
    return { done: true, message: row.operation === 'doc.create' ? 'Moved to your drafts' : null };
  } catch (error) {
    if (error instanceof Since) return { done: false, message: error.message };
    if (error instanceof WorkspaceAiBlockedError) throw error;
    // A domain refusal (a task already in use, a page someone else holds, a thought gone) is the same truth: it changed.
    if (error instanceof DomainError || (error instanceof Error && 'status' in error)) return { done: false, message: CHANGED_SINCE };
    throw error;
  } finally { for (const release of releases) release(); }
}
