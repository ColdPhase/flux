import { AGENT_MCP_ENTRIES, type AgentMcpCapabilityId, type AgentMcpPolicy } from './agent-mcp-policy.js';

export const ASSISTANT_AREAS = [
  { id: 'tasks', label: 'Read and edit tasks', reads: ['project.work.read', 'project.results.read'],
    operations: ['work.create', 'work.update', 'result.record', 'cowork.unit.create'] },
  { id: 'wiki', label: 'Read and edit the Wiki', reads: ['project.knowledge.read'], operations: ['doc.create', 'doc.update'] },
  { id: 'maps', label: 'Read and edit maps', reads: ['project.maps.read'],
    operations: ['map.create', 'map.rename', 'map.thought.create', 'map.thought.update', 'map.positions.update', 'map.link.create', 'map.thought.delete', 'map.link.delete'] },
  { id: 'conversations', label: 'Read conversations and reply', reads: ['project.conversations.read'],
    operations: ['conversation.reply', 'conversation.create'] },
  { id: 'decisions', label: 'Read decisions and suggest new ones', reads: ['project.decisions.read'], operations: ['decision.propose'] },
] as const;
export type AssistantAreaId = typeof ASSISTANT_AREAS[number]['id'];
export type AssistantAreaMode = 'off' | 'read' | 'edit';
export type AssistantAreas = Record<AssistantAreaId, AssistantAreaMode>;
export const DEFAULT_ASSISTANT_AREAS: Readonly<AssistantAreas> = {
  tasks: 'edit', wiki: 'edit', maps: 'edit', conversations: 'edit', decisions: 'edit',
};
export const ASSISTANT_LIMITS = { changesPerRun: { min: 1, max: 20, default: 20 },
  backgroundRunsPerDay: { min: 0, max: 24, default: 24 } } as const;
const CONTEXT_CAPABILITIES: AgentMcpCapabilityId[] = ['project.identity.read', 'project.policy.read'];

/** The one public area mapping. Membership is explicit: unrelated co-work/bootstrap entries stay off. */
export function compileAssistantAreas(areas: Readonly<AssistantAreas>): Pick<AgentMcpPolicy, 'enabledCapabilityIds' | 'enabledEntryIds'> {
  const capabilityIds = new Set<AgentMcpCapabilityId>(CONTEXT_CAPABILITIES);
  for (const area of ASSISTANT_AREAS) {
    if (areas[area.id] === 'off') continue;
    for (const id of area.reads) capabilityIds.add(id);
    if (areas[area.id] === 'edit') for (const id of area.operations) capabilityIds.add(id);
  }
  const entries = AGENT_MCP_ENTRIES.filter((entry) => entry.requiredCapabilities.every((id) => capabilityIds.has(id)));
  return { enabledCapabilityIds: [...capabilityIds].sort(), enabledEntryIds: entries.map((entry) => entry.id).sort() };
}

/**
 * Capabilities whose tools are never offered to the assistant (F-027 AST-3 "Not offered to the
 * assistant"): the co-work bootstrap, the playbook and the runtime-session reads of external clients.
 */
const NOT_FOR_RUNS = new Set<AgentMcpCapabilityId>(['cowork.playbook.read', 'connection.runtime.read']);

/**
 * The exact Flux tools of one assistant run, from the owner's switches (F-027 AST-4, A2): every read tool
 * the saved S6 policy enables, sorted. #280's first delivery step lists only read tools (F-027 question
 * 18); effect tools follow in slices A3 and A4. The same list serves `server` and `runtime` runs, so both
 * engines see the same tools and the MCP route lists exactly these to the run's token.
 */
export function assistantRunTools(policy: Pick<AgentMcpPolicy, 'enabledCapabilityIds' | 'enabledEntryIds'>, scopes: readonly string[]): string[] {
  return AGENT_MCP_ENTRIES.filter((entry) => entry.kind === 'tool' && entry.requiredScope === 'flux.context.read' && scopes.includes(entry.requiredScope)
    && policy.enabledEntryIds.includes(entry.id) && entry.requiredCapabilities.every((id) => policy.enabledCapabilityIds.includes(id) && !NOT_FOR_RUNS.has(id)))
    .map((entry) => entry.name).sort();
}

/** Projection only; the saved S6 policy remains the single authority store. */
export function assistantAreasFromPolicy(policy: Pick<AgentMcpPolicy, 'enabledCapabilityIds' | 'enabledEntryIds'>): AssistantAreas {
  const result = { ...DEFAULT_ASSISTANT_AREAS };
  for (const area of ASSISTANT_AREAS) {
    const reads = area.reads.every((id) => policy.enabledCapabilityIds.includes(id));
    const effects = area.operations.some((id) => policy.enabledCapabilityIds.includes(id));
    result[area.id] = !reads ? 'off' : effects ? 'edit' : 'read';
  }
  return result;
}

/** Only explicitly patched areas acquire the current entry set; approval/limit saves never admit new tools. */
export function patchAssistantAreas(policy: AgentMcpPolicy, changes: Partial<AssistantAreas>) {
  const capabilities = new Set(policy.enabledCapabilityIds);
  const entries = new Set(policy.enabledEntryIds);
  for (const area of ASSISTANT_AREAS) {
    const mode = changes[area.id];
    if (mode === undefined) continue;
    const owned = new Set<AgentMcpCapabilityId>([...area.reads, ...area.operations]);
    for (const id of owned) capabilities.delete(id);
    for (const entry of AGENT_MCP_ENTRIES) if (entry.requiredCapabilities.some((id) => owned.has(id))) entries.delete(entry.id);
    if (mode !== 'off') for (const id of area.reads) capabilities.add(id);
    if (mode === 'edit') for (const id of area.operations) capabilities.add(id);
    for (const entry of AGENT_MCP_ENTRIES) if (entry.requiredCapabilities.some((id) => owned.has(id))
      && entry.requiredCapabilities.every((id) => capabilities.has(id))) entries.add(entry.id);
  }
  return { enabledCapabilityIds: [...capabilities].sort(), enabledEntryIds: [...entries].sort() };
}

export interface AssistantSettings {
  workspaceId: string; ownerUserId: string; agentId: string; connectionId: string;
  approvalMode: 'act' | 'ask'; changesPerRun: number; backgroundRunsPerDay: number;
  areas: AssistantAreas; projectMode: 'all' | 'chosen'; policy: AgentMcpPolicy;
  version: number; createdAt: string; updatedAt: string;
}
export interface UpdateAssistantSettings {
  approvalMode?: 'act' | 'ask'; changesPerRun?: number; backgroundRunsPerDay?: number;
  areas?: Partial<AssistantAreas>; projectMode?: 'all' | 'chosen'; selectedProjectIds?: string[];
  expectedVersion?: number;
}
export interface AssistantJoinRequest {
  id: string; workspaceId: string; projectId: string; ownerUserId: string; agentId: string; connectionId: string;
  state: 'pending' | 'accepted' | 'declined'; version: number; createdAt: string; updatedAt: string;
}
export const assistantSettingsPath = (workspaceId: string, ownerUserId: string) =>
  `/api/v1/workspaces/${workspaceId}/assistants/${ownerUserId}/settings`;
export const assistantJoinRequestPath = (projectId: string) => `/api/v1/projects/${projectId}/assistant-join-requests`;
/** Project-scoped join questions lead to the manager's existing Agents request area. */
export const assistantJoinInboxPath = (notificationId: string) => `/inbox/${notificationId}`;
