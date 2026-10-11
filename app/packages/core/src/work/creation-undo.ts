import type { TaskCreationUndoEligibility } from '@flux/contracts';
import type { ActorRef } from './ports.js';

/**
 * What decides whether a reader may undo a task's creation (#238 AC-U1/AC-U2). Gathered from the task row and its
 * relations; `creatorAgentOwnerUserId` is the current owner of the genuine creator agent of a native agent task.
 */
export interface TaskCreationUndoFacts {
  reverted: boolean;
  origin: 'native_agent' | 'ai_proposal' | 'human' | null;
  baselineVersion: number | null;
  version: number;
  /** The monotonic first-use latch; it survives the later removal of whatever used the task. */
  used: boolean;
  /** The current own fields still equal the immutable creation baseline. */
  baselineMatches: boolean;
  prerequisites: number;
  createdBy: ActorRef;
  owner: ActorRef | null;
  creatorAgentOwnerUserId: string | null;
}

/** Who may undo: the agent that created it natively; a person who created it, owns it or owns its creator agent. */
export function mayUndoTaskCreation(facts: Pick<TaskCreationUndoFacts, 'origin' | 'createdBy' | 'owner' | 'creatorAgentOwnerUserId'>, principal: { kind: string; id: string }) {
  if (principal.kind === 'agent') return facts.origin === 'native_agent' && facts.createdBy.kind === 'agent' && facts.createdBy.id === principal.id;
  if (principal.kind !== 'human') return false;
  return (facts.createdBy.kind === 'human' && facts.createdBy.id === principal.id)
    || (facts.owner?.kind === 'human' && facts.owner.id === principal.id)
    || (facts.origin === 'native_agent' && facts.createdBy.kind === 'agent' && facts.creatorAgentOwnerUserId === principal.id);
}

/**
 * Read-only eligibility with bounded reason codes and no private owner, grant or helper detail. Older tasks without a
 * recorded origin and baseline stay `eligibility_unknown`: their use history is never guessed. The command rechecks
 * all of this, and the actor's current authority, under the task fence.
 */
export function creationUndoEligibility(facts: TaskCreationUndoFacts, principal: { kind: string; id: string }, canWrite: boolean): TaskCreationUndoEligibility {
  const no = (reason: TaskCreationUndoEligibility['reason']): TaskCreationUndoEligibility => ({ eligible: false, reason });
  if (facts.reverted) return no('already_reverted');
  if (!facts.baselineVersion || !facts.origin) return no('eligibility_unknown');
  if (facts.origin === 'human') return no('not_ai_origin');
  if (facts.used) return no('task_used');
  if (facts.version !== facts.baselineVersion || !facts.baselineMatches) return no('creation_changed');
  // A current dependency is an additional invariant; an earlier, removed one is covered by the use latch.
  if (facts.prerequisites > 0) return no('task_used');
  if (!canWrite) return no('not_authorized');
  return mayUndoTaskCreation(facts, principal) ? { eligible: true, reason: 'eligible' } : no('not_authorized');
}
