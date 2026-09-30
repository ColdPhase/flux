import { ASSISTANT_RUN_CHANGED_EVENT } from '@flux/contracts';
import type { PersonalRunPorts, RunChanges, RunRecord } from './ports.js';

// Owner-only progress of personal runs (#68, O-008 §4 "Progress"). Every status change of a run
// records `assistant_run.changed.v1` about the run itself. The access policy gives that object
// exactly one reader, the run's owner while active in its workspace, so the event's audience rows
// and its delivery are the owner's alone: nobody else learns that a run exists until an answer is
// committed to the conversation. The event carries identifiers only; the owner refetches the run.

/** Records the run's current status for its owner, in the caller's unit of work. */
export async function announce(ports: PersonalRunPorts, run: RunRecord): Promise<void> {
  await ports.events.record({ kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
}

/** Updates a run and, when its status or stop request changed, tells its owner. */
export async function updateAndAnnounce(ports: PersonalRunPorts, id: string, changes: RunChanges): Promise<RunRecord> {
  const updated = await ports.runs.updateRun(id, changes);
  if (changes.status !== undefined || changes.stopRequestedAt !== undefined) await announce(ports, updated);
  return updated;
}
