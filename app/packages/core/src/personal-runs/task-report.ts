import type { PersonalRunPorts, RunRecord } from './ports.js';
import { postToAgentChat } from './agent-chat.js';

// The one line an agent says about a run on a task when it ends (#919, F-036 AG-7): in its private chat with its owner, never in the Inbox.
// "Done: #4 Probe wiring" or "Stopped by Maja: #4 Probe wiring". The chat adds "· 3 changes · Undo" from what stands of the run's changes at
// the time it is read (`AgentChatMessage.changes`): the agent's last change, such as marking the task done, comes after the run ends, and an
// undone change leaves the line. Every other end (a limit, AI turned off, the connection revoked) is the task's own state line, not a report.

/** The words of the run's report, or null when this end is not reported. */
async function reportBody(ports: PersonalRunPorts, run: RunRecord): Promise<string | null> {
  if (run.kind !== 'task' || !run.workId) return null;
  if (run.status !== 'completed' && run.status !== 'truncated' && run.status !== 'stopped') return null;
  const label = await ports.runs.workLabel(run.workId);
  const task = label ? `#${label.number} ${label.title}` : 'a task';
  if (run.status === 'stopped') {
    // The owner reads this: their own stop is "by you", another person's is by name.
    const by = run.stopRequestedBy === null ? null : run.stopRequestedBy === run.ownerUserId ? 'you' : (await ports.runs.names([run.stopRequestedBy])).get(run.stopRequestedBy) ?? 'someone';
    return by ? `Stopped by ${by}: ${task}` : `Stopped: ${task}`;
  }
  return `Done: ${task}`;
}

/** Posts the report of a run that just ended, once (`report:<run>`), inside the transaction that ended it. */
export async function reportTaskRun(ports: PersonalRunPorts, run: RunRecord): Promise<void> {
  const body = await reportBody(ports, run);
  if (body) await postToAgentChat(ports, { agentId: run.agentId, runId: run.id, key: `report:${run.id}`, body });
}
