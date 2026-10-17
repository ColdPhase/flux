import { ASSISTANT_RUN_CHANGED_EVENT, ASSISTANT_WORKING_EVENT } from '@flux/contracts';
import type { PersonalRunPorts, RunChanges, RunRecord } from './ports.js';

// Owner-only progress of personal runs (#68, O-008 §4 "Progress"). Every status change of a run
// records `assistant_run.changed.v1` about the run itself. The access policy gives that object
// exactly one reader, the run's owner while active in its workspace, so the event's audience rows
// and its delivery are the owner's alone: the run, its prompt and its progress never leave the owner.
// The event carries identifiers only; the owner refetches the run. The one thing the others learn
// (F-027 AST-6) is that an assistant is working, by name, from `project.assistant_working.v1`.

/** Records the run's current status for its owner, in the caller's unit of work. */
export async function announce(ports: PersonalRunPorts, run: RunRecord): Promise<void> {
  await ports.events.record({ kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
  // F-027 AST-6: everyone in the place sees "Ada's assistant is working…". That is one identifier-only event to the project's audience when
  // a run starts working and when it stops; the detail (what it reads, Stop) stays in the owner's events above.
  if (run.status === 'reading' || !IN_FLIGHT.has(run.status))
    await ports.events.record({ kind: 'agent', id: run.agentId }, run.workspaceId, ASSISTANT_WORKING_EVENT, run.projectId, { conversationId: run.conversationId });
}
const IN_FLIGHT = new Set(['queued', 'reading', 'dispatching']);

/** Updates a run and, when its status or stop request changed, tells its owner. */
export async function updateAndAnnounce(ports: PersonalRunPorts, id: string, changes: RunChanges): Promise<RunRecord> {
  const updated = await ports.runs.updateRun(id, changes);
  if (changes.status !== undefined || changes.stopRequestedAt !== undefined) await announce(ports, updated);
  return updated;
}
