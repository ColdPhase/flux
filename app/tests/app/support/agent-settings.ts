import assert from 'node:assert/strict';
import { MY_AGENTS_PATH, type AgentMayDo, type MyAgentList } from '@flux/contracts';
import { expectStatus, type Person } from './people.js';

/** One agent's rights connection and "What it may do" (F-036 AG-1, AG-3), as its owner reads them. */
export interface AgentSettingsView { workspaceId: string; ownerUserId: string; agentId: string; connectionId: string; mayDo: AgentMayDo }
/** The owner's first agent in a workspace, read through their own session. */
export async function agentSettings(owner: Person, workspaceId: string): Promise<AgentSettingsView> {
  const { items } = expectStatus(await owner.browser.request('GET', MY_AGENTS_PATH), 200) as unknown as MyAgentList;
  const agent = items.find((item) => item.workspaceId === workspaceId);
  assert.ok(agent, 'the owner has an agent in this workspace');
  return { workspaceId, ownerUserId: owner.id, agentId: agent.id, connectionId: agent.connectionId, mayDo: agent.mayDo };
}
