import {
  MY_AGENTS_PATH, myAgentMemoryItemPath, myAgentMemoryPath, myAgentPath,
  type AddAgentMemoryCommand, type AgentMemory, type AgentMemoryItem, type CreateMyAgentCommand, type EditAgentMemoryCommand, type MyAgent, type MyAgentList, type UpdateMyAgentCommand,
} from '@flux/contracts';
import { request } from '../api/client';

// A person's agents (F-036 AG-1, #857). Every call acts as the signed-in person; only their own agents are ever returned.

export const listMyAgents = (signal?: AbortSignal) => request<MyAgentList>(MY_AGENTS_PATH, { signal }).then((list) => list.items);
export const getMyAgent = (agentId: string, signal?: AbortSignal) => request<MyAgent>(myAgentPath(agentId), { signal });
export const createMyAgent = (command: CreateMyAgentCommand) => request<MyAgent>(MY_AGENTS_PATH, { method: 'POST', body: command });
export const updateMyAgent = (agentId: string, command: UpdateMyAgentCommand) => request<MyAgent>(myAgentPath(agentId), { method: 'PATCH', body: command });
export const deleteMyAgent = (agentId: string) => request<null>(myAgentPath(agentId), { method: 'DELETE' });

export const getAgentMemory = (agentId: string, signal?: AbortSignal) => request<AgentMemory>(myAgentMemoryPath(agentId), { signal }).then((memory) => memory.items);
export const addAgentMemory = (agentId: string, command: AddAgentMemoryCommand) => request<AgentMemoryItem>(myAgentMemoryPath(agentId), { method: 'POST', body: command });
export const editAgentMemory = (agentId: string, itemId: string, command: EditAgentMemoryCommand) =>
  request<AgentMemoryItem>(myAgentMemoryItemPath(agentId, itemId), { method: 'PATCH', body: command });
export const deleteAgentMemory = (agentId: string, itemId: string) => request<null>(myAgentMemoryItemPath(agentId, itemId), { method: 'DELETE' });
