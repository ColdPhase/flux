import type { PersonalRunPorts, RunRecord } from './ports.js';
import { postToAgentChat } from './agent-chat.js';

// The one line an agent says about a run on a task when its outcome is known (#919, F-036 AG-7): in its private chat with its owner,
// never in the Inbox. "Done: #4 Probe wiring", "Blocked: #4 Probe wiring", "Back to you to check: #4 Probe wiring" or "Stopped by Maja: #4 Probe wiring". The chat adds
// "· 3 changes · Undo" from what stands of the run's changes when it is read (`AgentChatMessage.changes`).
//
// Who posts it:
// - a person's Stop, from `updateAndAnnounce`, in the transaction that ends the run;
// - Done, Blocked and Back to you, from the agent-task drain once it knows what became of the task (a run that ends by asking another agent has no
//   outcome yet: its follow-up run reports once).
// Every other end (AI turned off, a limit, the connection revoked, the system giving up) is the task's own state line, not a report.

export type TaskOutcome = 'done' | 'back' | 'blocked';

/** The words of the run's report, or null when this end is not reported. */
async function reportBody(ports: PersonalRunPorts, run: RunRecord, outcome: TaskOutcome | undefined): Promise<string | null> {
  if (run.kind !== 'task' || !run.workId) return null;
  const label = await ports.runs.workLabel(run.workId);
  const task = label ? `#${label.number} ${label.title}` : 'a task';
  if (run.status === 'stopped') {
    // Only a person's Stop is a report: AI turned off is the task's own state line, and the system's stop (`stopRunBy` with `system`) is not posted here.
    if (run.endReason === 'ai_off' || run.stopRequestedBy === null) return null;
    // The owner reads this: their own stop is "by you", another person's is by name.
    const by = run.stopRequestedBy === run.ownerUserId ? 'you' : (await ports.runs.names([run.stopRequestedBy])).get(run.stopRequestedBy) ?? 'someone';
    return `Stopped by ${by}: ${task}`;
  }
  if ((run.status === 'completed' || run.status === 'truncated') && outcome) return outcome === 'done' ? `Done: ${task}` : outcome === 'blocked' ? `Blocked: ${task}` : `Back to you to check: ${task}`;
  return null;
}

/** Posts the report of a run, once (`report:<run>`), in the caller's transaction. `outcome` is what became of the task when the run completed. */
export async function reportTaskRun(ports: PersonalRunPorts, run: RunRecord, outcome?: TaskOutcome): Promise<void> {
  const body = await reportBody(ports, run, outcome);
  if (body) await postToAgentChat(ports, { agentId: run.agentId, runId: run.id, key: `report:${run.id}`, body });
}
