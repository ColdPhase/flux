import type { AgentPeerRequestClass, AuthenticatedAgentRuntime } from '@flux/contracts';
import { coworkUnitCreationRows, accessReader } from '@flux/db';
import { assistantHandoffRunId, ConflictError, evaluateProject, normalizeCoWorkUnitCreate, requireOwnerAssistantHandoff, validateCoWorkUnitPolicy,
  type CoWorkContext, type CoWorkUnitPolicy, type Principal, type Transaction } from '@flux/core';
import { coWorkTaskGraphLocks } from './graph.js';
import type { CoWorkUnitCreation } from './units.js';

// The bounded owner-assistant hand-off (F-027 AST-3 "Hand-offs between the owner's agents"; docs/development/cowork-coordination.md
// "Owner-assistant handoff creation"). `ownerAssistantUnitCreationInTransaction` is reached only through the assistant change executor,
// which has already verified the run (or the owner's Apply of its saved change), the binding, the switches and the owner's rights and
// holds the run row; it is not a tool, a bearer or a parameter. It opens a pending root unit for another, external connection of the same
// owner and grants nobody a claim: the recipient still needs its own `cowork.claim` grant and its own session.

export interface AssistantHandoff {
  taskId: string;
  role: AgentPeerRequestClass;
  unitKey: string;
  expectedTaskVersion: number;
  assignmentConnectionId: string;
  parent: null;
}

/** Opens the pending unit, or returns the one this exact intent already opened. Errors escape the caller's transaction. */
export async function ownerAssistantUnitCreationInTransaction(tx: Transaction, runtime: AuthenticatedAgentRuntime, projectId: string,
  handoff: AssistantHandoff, policy: CoWorkUnitPolicy): Promise<CoWorkUnitCreation> {
  validateCoWorkUnitPolicy(policy);
  const input = normalizeCoWorkUnitCreate({ unitKey: handoff.unitKey, expectedTaskVersion: handoff.expectedTaskVersion,
    assignmentConnectionId: handoff.assignmentConnectionId, parent: handoff.parent });
  const rows = coworkUnitCreationRows(tx);
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId, connectionId: runtime.connectionId, agentId: runtime.agentId,
    ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  const rootRunId = assistantHandoffRunId(context.connectionId, handoff.taskId, input.unitKey);
  // The assistant's and the recipient's slots (sorted), the project graph, the complete task set; only then the rows read below.
  const facts = await rows.lock({ workspaceId: context.workspaceId, projectId, creatorConnectionId: context.connectionId,
    assigneeConnectionId: input.assignmentConnectionId, taskId: handoff.taskId, parentUnitId: null, rootRunId, unitKey: input.unitKey },
  (units) => coWorkTaskGraphLocks(tx, context.workspaceId, units));
  const decision = requireOwnerAssistantHandoff(context, facts, input, { taskId: handoff.taskId, role: handoff.role, rootRunId }, policy);
  const unit = decision.kind === 'existing' ? decision.unit : await rows.insert(context, { taskId: handoff.taskId,
    lineageTaskId: decision.lineageTaskId, runId: decision.runId, unitKey: input.unitKey, role: handoff.role,
    assignmentConnectionId: input.assignmentConnectionId });
  if (!unit) throw new ConflictError('This unit key was used for another unit', 'COWORK_UNIT_CONFLICT');
  // #238: a new unit is a persisted use of its task, under the task pass the lock above retains.
  if (decision.kind !== 'existing') await facts.taskFence.mark([unit.taskId, unit.lineageTaskId]);
  return { status: decision.kind === 'existing' ? 'existing' : 'created', unitId: unit.id, taskId: unit.taskId, lineageTaskId: unit.lineageTaskId,
    runId: unit.runId, role: unit.role, assignmentConnectionId: unit.assignmentConnectionId, version: unit.version, state: unit.state };
}

export type HandoffUndo =
  | { result: 'cancelled' }
  /** The recipient has claimed or worked on it: nothing changes, and the owner is told so. */
  | { result: 'started'; recipient: string }
  /** Gone, stopped by someone, touched since it was created, or the one undoing it no longer may write in the project. */
  | { result: 'changed' };

/**
 * The owner's Undo of a hand-off: it cancels only the untouched, never-claimed pending unit, at exactly the version it was created at,
 * under the same lock order a claim takes, so a concurrent claim and Undo serialize on the unit and one of them wins whole. After the
 * recipient started it changes nothing: it never releases a claim, stops a CLI or touches a grant. The row and its run count remain.
 */
export async function cancelOwnerAssistantUnitInTransaction(tx: Transaction, by: Principal, scope: { workspaceId: string; projectId: string;
  assistantConnectionId: string; taskId: string; unitId: string; creationVersion: number }): Promise<HandoffUndo> {
  // Whoever undoes it, the owner included, needs write access to the project now: a person removed or downgraded since cannot cancel a unit
  // there. The rights come first (locked, as everywhere), then the connection slots, the graph, the tasks and the unit row.
  if (!(await evaluateProject(by, 'project.write', scope.projectId, accessReader(tx), { lock: true })).allowed) return { result: 'changed' };
  const rows = coworkUnitCreationRows(tx);
  const locked = await rows.lockUnit({ workspaceId: scope.workspaceId, projectId: scope.projectId, creatorConnectionId: scope.assistantConnectionId,
    taskId: scope.taskId, unitId: scope.unitId }, (units) => coWorkTaskGraphLocks(tx, scope.workspaceId, units));
  if (!locked) return { result: 'changed' };
  const { unit } = locked;
  const recipient = await rows.recipient(scope.workspaceId, unit.assignmentConnectionId);
  const started = unit.generation > 0 && unit.state !== 'stopped' || unit.state === 'claimed' || unit.state === 'paused' || unit.state === 'completed';
  if (started) return { result: 'started', recipient: recipient?.clientDesignation === 'codex' ? 'Codex' : recipient?.clientDesignation === 'claude_code' ? 'Claude Code' : recipient?.name ?? 'agent' };
  if (unit.state !== 'pending' || unit.version !== scope.creationVersion) return { result: 'changed' };
  return (await rows.cancelPending(scope, unit.id, scope.creationVersion)) ? { result: 'cancelled' } : { result: 'changed' };
}
