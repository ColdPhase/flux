import type { Agent, NativeWorkRow, ProjectAccess, ProjectAgentConnection, ProjectPerson, WorkRowProjection } from '@flux/contracts';

/**
 * Who the Agents view and the hand-off dialog list (F-026 P9, S12): the agents that can read this
 * project now (its people), each external connection of one, and, for a hand-off, the workspace's
 * agents with no access here so the dialog can say so instead of silently leaving them out.
 */
export interface AgentEntry {
  /** One row: a connection, or an agent without one. */
  key: string;
  agentId: string;
  name: string;
  /** "Ada", "Ada (you)" or "the workspace"; null when it cannot be told. */
  owner: string | null;
  /** The client and connection name, e.g. "Claude Code · Desk laptop". */
  via: string | null;
  connection: ProjectAgentConnection | null;
  /** The agent's grant in this project; null when it has none (it cannot read it). */
  access: ProjectAccess | null;
}

/** An expired session is offline even before the next server observation. */
export function connectionState(connection: ProjectAgentConnection, now: number): ProjectAgentConnection['state'] {
  return connection.state === 'session_open' && connection.session && Date.parse(connection.session.expiresAt) <= now ? 'offline' : connection.state;
}

/** Native task ownership/status is assignment; only a claimed unit on a usable live connection proves work. */
export function isAgentWorking(entry: AgentEntry, now: number): boolean {
  const connection = entry.connection;
  return !!connection?.session && connection.currentWork?.state === 'claimed' && connectionState(connection, now) === 'session_open'
    && Date.parse(connection.session.expiresAt) > now;
}

export const WORK_ROLE: Record<NonNullable<ProjectAgentConnection['currentWork']>['role'], string> = {
  execute: 'Task work', review: 'Review', plan: 'Planning',
};

/** Preserve the recorded unit state while distinguishing a disconnected claim from current execution. */
export function currentWorkLine(work: NonNullable<ProjectAgentConnection['currentWork']>, working: boolean): string {
  if (work.state === 'claimed') return working ? `Working on “${work.taskTitle}”` : `Work held on “${work.taskTitle}”`;
  return work.state === 'paused' ? `Paused on “${work.taskTitle}”` : `Assigned “${work.taskTitle}”, not started`;
}

export const CLIENT_LABEL: Record<ProjectAgentConnection['clientDesignation'], string> = {
  claude_code: 'Claude Code', codex: 'Codex', other: 'External client',
};

export function agentEntries(people: readonly ProjectPerson[] | null, connections: readonly ProjectAgentConnection[], workspaceAgents: readonly Agent[] = [], humans: ReadonlyMap<string, string> = new Map()): AgentEntry[] {
  const accessOf = new Map((people ?? []).filter((person) => person.kind === 'agent').map((person) => [person.id, person]));
  const entries: AgentEntry[] = connections.map((connection) => ({
    key: `connection:${connection.id}`, agentId: connection.agent.id, name: connection.agent.name,
    owner: `${connection.owner.name}${connection.own ? ' (you)' : ''}`,
    via: `${CLIENT_LABEL[connection.clientDesignation]} · ${connection.name}`,
    connection, access: accessOf.get(connection.agent.id)?.access ?? null,
  }));
  const seen = new Set(entries.map((entry) => entry.agentId));
  for (const person of accessOf.values()) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    entries.push({ key: `agent:${person.id}`, agentId: person.id, name: person.name, connection: null, via: null, access: person.access,
      owner: person.agentOwner ? person.agentOwner.kind === 'workspace' ? 'the workspace' : person.agentOwner.name : null });
  }
  for (const agent of workspaceAgents) {
    if (seen.has(agent.id) || agent.revokedAt) continue;
    seen.add(agent.id);
    entries.push({ key: `agent:${agent.id}`, agentId: agent.id, name: agent.name, connection: null, via: null, access: null,
      owner: agent.owner.kind === 'workspace' ? 'the workspace' : humans.get(agent.owner.id) ?? null });
  }
  return entries;
}

/** Tasks an agent holds now: unfinished and unparked, in progress first. The read is one bounded page. */
export function tasksHeldBy(agentId: string, rows: readonly NativeWorkRow[]): WorkRowProjection[] {
  return rows.filter((row): row is WorkRowProjection => row.kind === 'work' && row.owner?.kind === 'agent' && row.owner.id === agentId && !row.parked
    && (row.status === 'in_progress' || row.status === 'open' || row.status === 'blocked'))
    .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || a.number - b.number);
}

/** What the grant lets the agent do here, in the words of the product rules (agents never accept decisions). */
export function mayDo(access: ProjectAccess | null): { can: string; canTake: boolean } {
  if (access === 'contributor' || access === 'manager') {
    return { can: 'read this project and write in it: messages, results, tasks and proposed decisions. It can’t accept decisions or invite people.', canTake: true };
  }
  if (access === 'viewer') return { can: 'read this project. It can’t post, change tasks or propose decisions.', canTake: false };
  return { can: 'nothing here yet: it has no access to this project.', canTake: false };
}
