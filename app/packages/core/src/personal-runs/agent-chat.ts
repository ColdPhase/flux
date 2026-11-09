import { ASSISTANT_RUN_CHANGED_EVENT, type AgentChatMessage } from '@flux/contracts';
import type { PersonalRunPorts } from './ports.js';
import { redactSecrets } from './redaction.js';

// What an agent says on its own in its private chat (#842, F-036 AG-4, AG-7): the reports of its work ("Done: #4 … · 3 changes · Undo",
// "Stopped by Maja"). The owner's words and the agent's answers to them are runs; these are its own lines, each about one run.

/**
 * The one way a line gets into an agent's chat, in the caller's unit of work (server or worker). `key` names the line for the agent, so a report
 * tried twice posts once and the second call returns the first. The words are redacted like every agent text (AG-11). Returns null when
 * the agent is gone, the run is not the agent's or there are no words. `runId` is null for a schedule's firing that could not start (C-53): no
 * run, so no owner event (the open chat reads the line when it next reads; `unreadAgentChats` has it at once). The owner's open chat reads again through the run's own owner-only event;
 * what is unread comes from `unreadAgentChats`.
 */
export async function postToAgentChat(ports: PersonalRunPorts, line: { agentId: string; runId: string | null; key: string; body: string; schedule?: AgentChatMessage['schedule'] }): Promise<AgentChatMessage | null> {
  const body = redactSecrets(line.body).text.trim().slice(0, 100_000);
  const run = line.runId ? await ports.runs.findRun(line.runId) : null;
  if (!body || (line.runId !== null && (!run || run.agentId !== line.agentId))) return null;
  const schedule = line.schedule ? { ...line.schedule, title: redactSecrets(line.schedule.title).text } : undefined;
  const posted = await ports.runs.postAgentChat({ ...line, body, ...(schedule ? { schedule } : {}) });
  if (!posted) return null;
  if (posted.created && run) await ports.events.record({ kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status, chat: true });
  return posted.message;
}

/** What the person has not read in the chats of their agents: for each agent, the unread lines (answers and reports) and when it last spoke. */
export const unreadAgentChats = (ports: PersonalRunPorts, ownerUserId: string) => ports.runs.agentChatSummaries(ownerUserId);
