import { useEffect, useState } from 'react';
import type { Agent, WorkspaceMember } from '@flux/contracts';
import { listWorkspaceMembers } from '../app/conversation-api';
import { listAgents } from '../work/api';

/** Who each agent works for, by agent id: its owner's current name, or "the workspace". */
export type AgentOwners = ReadonlyMap<string, string>;

const cache = new Map<string, Promise<AgentOwners>>();

async function load(workspaceId: string): Promise<AgentOwners> {
  const [agents, members] = await Promise.all([
    listAgents(workspaceId).catch(() => [] as Agent[]),
    listWorkspaceMembers(workspaceId).catch(() => [] as WorkspaceMember[]),
  ]);
  const names = new Map(members.map((member) => [member.userId, member.name]));
  return new Map(agents.flatMap((agent) => {
    if (agent.owner.kind === 'workspace') return [[agent.id, 'the workspace'] as const];
    const name = names.get(agent.owner.id);
    return name ? [[agent.id, name] as const] : [];
  }));
}

/**
 * The owners of a workspace's agents, for "for <owner>" (F-026 P3). One read per workspace per visit;
 * a reader who may not list agents or members simply sees no owner line.
 */
export function useAgentOwners(workspaceId: string | null | undefined): AgentOwners {
  const [owners, setOwners] = useState<AgentOwners>(new Map());
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    let pending = cache.get(workspaceId);
    if (!pending) {
      pending = load(workspaceId);
      cache.set(workspaceId, pending);
      // A failed read is not remembered, so the next view tries again.
      pending.catch(() => cache.delete(workspaceId));
    }
    void pending.then((map) => { if (live) setOwners(map); }, () => undefined);
    return () => { live = false; };
  }, [workspaceId]);
  return owners;
}
