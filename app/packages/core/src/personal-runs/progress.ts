import { ASSISTANT_RUN_CHANGED_EVENT } from '@flux/contracts';
import type { PersonalRunPorts, RunChanges, RunRecord } from './ports.js';
import { reportTaskRun } from './task-report.js';

// Owner-only progress of personal runs (#68, O-008 §4 "Progress"). Every status change of a run
// records `assistant_run.changed.v1` about the run itself. The access policy gives that object
// exactly one reader, the run's owner while active in its workspace, so the event's audience rows
// and its delivery are the owner's alone: the run, its prompt and its progress never leave the owner.
// The event carries identifiers only; the owner refetches the run. The others learn nothing about a run: what a run on a task says to
// them is a message of the task's discussion (#1120), and there is no "is working" line (nothing read the event that said it).

/** Records the run's current status for its owner, in the caller's unit of work. */
export async function announce(ports: PersonalRunPorts, run: RunRecord): Promise<void> {
  await ports.events.record({ kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
}

/** Updates a run and, when its status or stop request changed, tells its owner. */
export async function updateAndAnnounce(ports: PersonalRunPorts, id: string, changes: RunChanges, options: { report?: boolean } = {}): Promise<RunRecord> {
  const updated = await ports.runs.updateRun(id, changes);
  if (changes.status !== undefined || changes.stopRequestedAt !== undefined) await announce(ports, updated);
  // The end of a run on a task is reported to its agent's private chat (#919); the run's own end is already in this transaction.
  if (changes.status !== undefined && options.report !== false) await reportTaskRun(ports, updated);
  return updated;
}
