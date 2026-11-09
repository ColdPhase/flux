import { authorLabel, FORMER_MEMBER } from '../agent-tasks/ask.js';
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
  // The name its owner knows a schedule by is the label its run was started with (`startBackground`).
  const scheduleTitle = run.kind === 'scheduled' ? run.backgroundLabel : null;
  return { ownerName, agentName: brief?.name ?? 'Assistant', timeZone, place, task, scheduleTitle };
}

/** The latest messages of a place, and whether older ones exist: one more than the window is read to know it. */
export async function latestMessages(read: (limit: number) => Promise<MessageSource[]>): Promise<{ messages: MessageSource[]; leftOut: boolean }> {
  const rows = await read(MESSAGE_WINDOW + 1);
  return rows.length > MESSAGE_WINDOW ? { messages: rows.slice(rows.length - MESSAGE_WINDOW), leftOut: true } : { messages: rows, leftOut: false };
}

/**
 * A space's messages with their authors as people see them (#1160, `authorLabel`): a person by name and an agent with whose it is, "Fieldbot
 * (Jonas's agent)", but only someone who can read the space now is named, which everyone who reads the space sees in its People list (so an
 * answer posted with Show everyone names nobody its readers could not see). Anyone else is a former member, an agent's owner too.
 */
export async function namedAuthors(ports: PersonalRunPorts, projectId: string, messages: readonly MessageSource[]): Promise<MessageSource[]> {
  const people = new Set(messages.flatMap((message) => message.author.kind === 'human' ? [message.author.id] : message.author.ownerUserId ? [message.author.ownerUserId] : []));
  const readers = new Set<string>();
  for (const id of people) if (await ports.access.canUseProject({ kind: 'human', id }, 'read', projectId)) readers.add(id);
  const owners = await ports.runs.names(messages.flatMap((message) => message.author.kind === 'agent' && message.author.ownerUserId && readers.has(message.author.ownerUserId) ? [message.author.ownerUserId] : []));
  return messages.map((message) => ({ ...message, authorName: message.author.kind === 'human' ? (readers.has(message.author.id) ? message.authorName : FORMER_MEMBER)
    : authorLabel({ kind: 'agent', name: message.authorName, ownerName: owners.get(message.author.ownerUserId ?? '') ?? null }) }));
}
