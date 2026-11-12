import type { ConversationMessage } from '@flux/contracts';
import { authorLabel, evaluateProject, firstName, sharedFirstNames } from '@flux/core';
import { accessReader, personalRunRows, schema, type Executor } from '@flux/db';
import { inArray } from 'drizzle-orm';
import { projectAuthorOwners } from '../conversation/author-owners.js';

// Who wrote what, as people see it, in what the Flux tools return to an agent (#1160). A reading agent is told a person's name only when that
// person can read the space now (`project.read`: its people, and the company's owners and admins, who reach every space), which is no more
// than a member of the space sees named there, and an agent's owner by the same rule (`projectAuthorOwners`). A person who left the company
// or the space is a former member, as the space's own views show them (#763 XC-2). The ids stay, for the tools that take them.

/** How the conversation reads and the search tools name who wrote each message (#1160): as people see it, so a person's posted answer is never taken for the reader's own. */
export const AUTHORS = 'Each message names its author as people see them (author.name): a person by name ("Former member" once they can no longer read this space); '
  + 'an agent with whose it is, "Assistant (Ada\'s agent)"; and "Ada Nowak · via Assistant" for an answer of Ada\'s agent that Ada posted, which is Ada\'s message, '
  + 'not yours. author.id is the person\'s or the agent\'s id.';

/** The agent a read names (a message's author, a task's owner or creator, a conversation's starter): `{kind: 'agent', id, name}`. */
type AgentRef = { kind: 'agent'; id: string; name?: string; projectOwner?: unknown };
/** An object of the result as it will be written out; a Date or another class instance is a value, not something to walk. */
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isAgent = (value: unknown): value is AgentRef => plainObject(value) && value.kind === 'agent' && typeof value.id === 'string';

/** Every agent named anywhere in `value`, by id, with its own name. */
function agentsIn(value: unknown, found: Map<string, string>): Map<string, string> {
  if (Array.isArray(value)) for (const item of value) agentsIn(item, found);
  else if (plainObject(value)) {
    if (isAgent(value) && !found.has(value.id)) found.set(value.id, value.name ?? 'Agent');
    for (const item of Object.values(value)) agentsIn(item, found);
  }
  return found;
}

function relabelled(value: unknown, labels: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => relabelled(item, labels));
  if (!plainObject(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, relabelled(item, labels)] as const);
  if (!isAgent(value)) return Object.fromEntries(entries);
  // The owner is in the label now; its id stays out, as before for an owner who cannot read the space.
  return Object.fromEntries([...entries.filter(([key]) => key !== 'projectOwner' && key !== 'name'), ['name', labels.get(value.id)!]]);
}

async function userNames(db: Executor, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The people of `ids` who can read the space now, by name: the only people a reading agent is told the name of. */
export async function spaceReadersNamed(db: Executor, projectId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const visible: string[] = [];
  for (const id of new Set(ids)) if ((await evaluateProject({ kind: 'human', id }, 'project.read', projectId, accessReader(db))).allowed) visible.push(id);
  return userNames(db, visible);
}

/**
 * Every agent a read names, named as Flux labels it: "Assistant (Ada's agent)", so that two people's agents of the same name, and another
 * person's agent and the reader itself, are never mistaken for each other (#1160); "Assistant (Ada Nowak's agent)" when someone else who can
 * read the space is called Ada too (#1163), as the reader's brief names its own. An agent whose owner cannot read the space now is
 * "Assistant (a former member's agent)".
 */
export async function withAgentLabels<T>(db: Executor, projectId: string, workspaceId: string, value: T): Promise<T> {
  const agents = agentsIn(value, new Map());
  if (!agents.size) return value;
  const ids = [...agents.keys()];
  const owners = new Map<string, string>();
  // `projectAuthorOwners` reads a bounded window of authors at a time.
  for (let start = 0; start < ids.length; start += 100)
    for (const [agentId, owner] of await projectAuthorOwners(db, projectId, workspaceId, ids.slice(start, start + 100))) owners.set(agentId, owner.id);
  const names = await userNames(db, [...owners.values()]);
  // Who else that can read the space shares an owner's first name (#1163), the rule the brief's `namesakesIn` follows.
  const readers = [];
  for (const person of await personalRunRows(db).namesakes(workspaceId, [...names.values()].map(firstName)))
    if ((await evaluateProject({ kind: 'human', id: person.id }, 'project.read', projectId, accessReader(db))).allowed) readers.push(person);
  const full = sharedFirstNames([...new Map([...[...names].map(([id, name]) => ({ id, name })), ...readers].map((person) => [person.id, person])).values()]);
  const labels = new Map([...agents].map(([id, name]) => [id, authorLabel({ kind: 'agent', name, ownerName: names.get(owners.get(id) ?? '') ?? null,
    full: full.has(owners.get(id) ?? '') })]));
  return relabelled(value, labels) as T;
}

/** A message as a reading agent gets it (#1160): its author, a person or an agent, named as people see them; the rest as stored. */
export type AgentReadMessage = Omit<ConversationMessage, 'authorId' | 'author' | 'via'> & { author: { kind: 'human' | 'agent'; id: string; name: string } };

/**
 * The messages of a space's conversation or a task's discussion for a reading agent: each with `author: {kind, id, name}`, where a person's
 * post of their agent's answer reads "Ada Nowak · via Assistant" (theirs, never the reader's own words). Agents are labelled with their
 * owner by `withAgentLabels`, which the caller applies to the whole result.
 */
export async function messagesForAgents(db: Executor, projectId: string, messages: readonly ConversationMessage[]): Promise<AgentReadMessage[]> {
  const names = await spaceReadersNamed(db, projectId, messages.flatMap((message) => message.authorId !== null ? [message.authorId] : []));
  return messages.map((message) => {
    const { authorId: _authorId, author: _author, via, id, conversationId, sequence, createdAt, body, ...rest } = message;
    void _authorId; void _author;
    return { id, conversationId, sequence, createdAt,
      author: message.authorId !== null ? { kind: 'human' as const, id: message.authorId, name: authorLabel({ kind: 'human', name: names.get(message.authorId) ?? null, via: via ?? null }) }
        : { kind: 'agent' as const, id: message.author.id, name: message.author.name ?? 'Agent' },
      body, ...rest };
  });
}
