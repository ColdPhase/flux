import { randomUUID } from 'node:crypto';
import type { Agent, CreateAgentCommand } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { enforce, evaluateAgent, evaluateWorkspace, requireWorkspaceAi } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { AgentRecord } from './records.js';
import { name, oneOf } from './validation.js';

// Agent identities (issues #46, #91); agent authentication is a later task.

type AgentPorts = Pick<AccessPorts, 'agents' | 'access' | 'events'>;

function toAgent(row: AgentRecord): Agent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    owner: { kind: 'human', id: row.ownerUserId },
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every agent belongs to the person who creates it and acts with exactly their rights (F-036 AG-1, AG-3). */
export async function createAgent(principal: Principal, workspaceId: string, command: CreateAgentCommand, db: Database, ports: AgentPorts): Promise<Agent> {
  const agentName = name(command?.name);
  if (command.owner !== undefined) oneOf(command.owner, ['self'] as const, 'owner');
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, 'agent.create', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    // F-029: no new agent identity while AI is off in the workspace (revoking and listing stay).
    await requireWorkspaceAi(ports.access(tx), workspaceId, { lock: true });
    const id = randomUUID();
    const row = await ports.agents(tx).insert({ id, workspaceId, name: agentName, ownerUserId: principal.id, createdBy: principal.id });
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'agent.created.v1', id, { owner: 'self' });
    return toAgent(row);
  });
}

export async function listAgents(principal: Principal, workspaceId: string, db: Database, ports: AgentPorts): Promise<Agent[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.read_members', workspaceId, ports.access(db)), 'workspace');
  return (await ports.agents(db).listVisible(principal, workspaceId)).map(toAgent);
}

/** Revokes an agent identity; it stops acting on its next call. The owner or a workspace owner/admin may revoke. */
export async function revokeAgent(principal: Principal, agentId: string, db: Database, ports: AgentPorts): Promise<Agent> {
  return db.transaction(async (tx) => {
    const { agent } = enforce(await evaluateAgent(principal, 'agent.revoke', agentId, ports.access(tx), { lock: true }), 'agent');
    const row = await ports.agents(tx).revoke(agentId, agent!.revokedAt ?? new Date());
    await recordEvent(eventPorts(ports, tx), principal, agent!.workspaceId, 'agent.revoked.v1', agentId, {});
    return toAgent(row);
  });
}
