import type { BriefPlace, TaskFacts } from './brief.js';
import type { AgentBrief, MessageSource, PersonalRunPorts, RunRecord } from './ports.js';

// What a run's brief says about who asks, where and when (#1064), read for both engines. The callers have authorized the run's place
// before (the space's AI switch at the run's epoch and the agent's read, or the owner's part in the DM): nothing here decides access, and
// nothing is read outside the run's own place.

/** How many messages of a place a run is given: the latest of them. */
export const MESSAGE_WINDOW = 40;
/** How many earlier exchanges of a private chat the agent is told. */
export const CHAT_TURNS = 6;

export interface BriefFacts {
  ownerName: string;
  agentName: string;
  timeZone: string;
  place: BriefPlace;
  task: TaskFacts | null;
  scheduleTitle: string | null;
}

export async function readBriefFacts(ports: PersonalRunPorts, run: RunRecord, brief: AgentBrief | null): Promise<BriefFacts> {
  const ownerName = (await ports.runs.names([run.ownerUserId])).get(run.ownerUserId) ?? 'your owner';
  const timeZone = await ports.runs.personTimeZone(run.ownerUserId);
  const named = run.projectId === null && run.dmId === null ? null : await ports.runs.placeNames({ projectId: run.projectId, conversationId: run.conversationId, dmId: run.dmId });
  const place: BriefPlace = run.projectId !== null ? { kind: 'space', spaceId: run.projectId, spaceName: named?.spaceName ?? null, conversationId: run.conversationId, task: named?.task ?? null }
    : run.dmId !== null ? { kind: 'dm', others: (named?.people ?? []).filter((person) => person.id !== run.ownerUserId).map((person) => person.name), thread: run.dmThreadRootId !== null }
      : { kind: 'chat' };
  // A task run and an answer about a task are told the task, only when it is in the run's own space.
  const found = run.workId !== null && run.projectId !== null ? await ports.runs.taskBrief(run.workId) : null;
  const task: TaskFacts | null = found && found.projectId === run.projectId ? {
    id: found.id, number: found.number, title: found.title, status: found.status, outcome: found.outcome, criteria: found.criteria,
    dueOn: found.dueOn, blocker: found.blocker, prerequisites: found.prerequisites,
  } : null;
  const scheduleTitle = run.kind === 'scheduled' ? (await ports.runs.jobOfRun?.(run.id))?.title ?? null : null;
  return { ownerName, agentName: brief?.name ?? 'Assistant', timeZone, place, task, scheduleTitle };
}

/** The latest messages of a place, and whether older ones exist: one more than the window is read to know it. */
export async function latestMessages(read: (limit: number) => Promise<MessageSource[]>): Promise<{ messages: MessageSource[]; leftOut: boolean }> {
  const rows = await read(MESSAGE_WINDOW + 1);
  return rows.length > MESSAGE_WINDOW ? { messages: rows.slice(rows.length - MESSAGE_WINDOW), leftOut: true } : { messages: rows, leftOut: false };
}
