import { authorLabel, firstName, FORMER_MEMBER, sharedFirstNames } from '../agent-tasks/ask.js';
import type { BriefPlace, TaskFacts } from './brief.js';
import type { AgentBrief, MessageSource, PersonalRunPorts, RunRecord } from './ports.js';

// What a run's brief says about who asks, where and when (#1064). The callers have authorized the run's place
// before (the space's AI switch at the run's epoch and the agent's read, or the owner's part in the DM): nothing here decides access, and
// nothing is read outside the run's own place.

/**
 * How many messages of a place a run is given: the latest of them (founder, 2026-11-12, F-042: 20, not fewer). Older ones are found with `flux_search`
 * and `flux_read_around`, and the brief says so when some were left out.
 */
export const MESSAGE_WINDOW = 20;
/** How many earlier exchanges of a private chat the agent is told. */
export const CHAT_TURNS = 6;

export interface BriefFacts {
  ownerName: string;
  agentName: string;
  /** The agent's id, which the Flux tools give as `author.id` on its own messages (#1163). */
  agentId: string;
  /** Its owner shares a first name with someone else who can read the run's space: the agent is labelled with the owner's full name (#1163). */
  namesake: boolean;
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
  const namesake = run.projectId !== null && (await namesakesIn(ports, run.workspaceId, run.projectId, [{ id: run.ownerUserId, name: ownerName }])).has(run.ownerUserId);
  return { ownerName, agentName: brief?.name ?? 'Assistant', agentId: run.agentId, namesake, timeZone, place, task, scheduleTitle };
}

/** The latest messages of a place, and whether older ones exist: one more than the window is read to know it. */
export async function latestMessages(read: (limit: number) => Promise<MessageSource[]>): Promise<{ messages: MessageSource[]; leftOut: boolean }> {
  const rows = await read(MESSAGE_WINDOW + 1);
  return rows.length > MESSAGE_WINDOW ? { messages: rows.slice(rows.length - MESSAGE_WINDOW), leftOut: true } : { messages: rows, leftOut: false };
}

/** Of these agents' owners, those who share a first name with someone else who can read the space now (#1163). */
async function namesakesIn(ports: PersonalRunPorts, workspaceId: string, projectId: string, owners: readonly { id: string; name: string }[]): Promise<Set<string>> {
  const readers = [];
  for (const person of await ports.runs.namesakes(workspaceId, owners.map((owner) => firstName(owner.name))))
    if (await ports.access.canUseProject({ kind: 'human', id: person.id }, 'read', projectId)) readers.push(person);
  return sharedFirstNames([...new Map([...owners, ...readers].map((person) => [person.id, person])).values()]);
}

/**
 * A space's messages with their authors as people see them (#1160, `authorLabel`): a person by name and an agent with whose it is, "Fieldbot
 * (Jonas's agent)", with the owner's full name when someone else who can read the space has the same first name (#1163). Only someone who
 * can read the space now is named, which is no more than its members see named there; anyone else is a former member, an agent's owner too.
 */
export async function namedAuthors(ports: PersonalRunPorts, run: Pick<RunRecord, 'workspaceId'> & { projectId: string }, messages: readonly MessageSource[]): Promise<MessageSource[]> {
  const people = new Set(messages.flatMap((message) => message.author.kind === 'human' ? [message.author.id] : message.author.ownerUserId ? [message.author.ownerUserId] : []));
  const readers = new Set<string>();
  for (const id of people) if (await ports.access.canUseProject({ kind: 'human', id }, 'read', run.projectId)) readers.add(id);
  const owners = await ports.runs.names(messages.flatMap((message) => message.author.kind === 'agent' && message.author.ownerUserId && readers.has(message.author.ownerUserId) ? [message.author.ownerUserId] : []));
  const full = await namesakesIn(ports, run.workspaceId, run.projectId, [...owners].map(([id, name]) => ({ id, name })));
  return messages.map((message) => ({ ...message, authorName: message.author.kind === 'human' ? (readers.has(message.author.id) ? message.authorName : FORMER_MEMBER)
    : authorLabel({ kind: 'agent', name: message.authorName, ownerName: owners.get(message.author.ownerUserId ?? '') ?? null, full: full.has(message.author.ownerUserId ?? '') }) }));
}
