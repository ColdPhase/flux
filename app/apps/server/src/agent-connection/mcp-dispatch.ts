import { AsyncLocalStorage } from 'node:async_hooks';
import { AGENT_MCP_ENTRIES, type AgentMcpCapabilityId, type AgentMcpEntry } from '@flux/contracts';
import { DomainError, type AgentProjectObjectKind } from '@flux/core';

export interface McpProjectDependency { projectId: string; action: 'project.read' | 'project.write' }
export interface McpObjectDependency { projectId: string; kind: AgentProjectObjectKind; id: string }
export interface McpDeliveryDependencies {
  capturedVersion: number;
  entryIds: Set<string>;
  capabilities: Set<AgentMcpCapabilityId>;
  projects: Map<string, McpProjectDependency['action']>;
  objects: Map<string, McpObjectDependency>;
  protectedOutput: boolean;
}

/** One verified request owns this context; nothing is a module-global identity/policy cache. */
export function createMcpDispatch(capturedVersion: number) {
  if (!Number.isInteger(capturedVersion) || capturedVersion < 1) throw new Error('A captured policy version is required');
  const scope = new AsyncLocalStorage<AgentMcpEntry>();
  const registered = new Set<string>();
  const dependencies: McpDeliveryDependencies = { capturedVersion, entryIds: new Set(), capabilities: new Set(),
    projects: new Map(), objects: new Map(), protectedOutput: false };
  return {
    dependencies,
    declare(kind: AgentMcpEntry['kind'], name: string) {
      const entry = AGENT_MCP_ENTRIES.find((candidate) => candidate.kind === kind && candidate.name === name);
      if (!entry || registered.has(entry.id)) throw new Error('Every MCP registration needs one exact permission');
      registered.add(entry.id);
    },
    verifyRegistrations() {
      if (registered.size !== AGENT_MCP_ENTRIES.length || AGENT_MCP_ENTRIES.some((entry) => !registered.has(entry.id)))
        throw new Error('The MCP manifest must match every actual tool, resource and prompt');
    },
    current() {
      const entry = scope.getStore();
      if (!entry) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'A registered permission is required');
      return entry;
    },
    run<T>(kind: AgentMcpEntry['kind'], name: string, callback: () => T): T {
      const entry = AGENT_MCP_ENTRIES.find((candidate) => candidate.kind === kind && candidate.name === name);
      if (!entry) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
      dependencies.protectedOutput = true;
      dependencies.entryIds.add(entry.id);
      for (const capability of entry.requiredCapabilities) dependencies.capabilities.add(capability);
      return scope.run(entry, callback);
    },
    requireCapabilities(capabilities: readonly AgentMcpCapabilityId[]) {
      for (const capability of capabilities) dependencies.capabilities.add(capability);
    },
    project(projectId: string, action: McpProjectDependency['action']) {
      if (dependencies.projects.get(projectId) !== 'project.write') dependencies.projects.set(projectId, action);
    },
    object(projectId: string, kind: AgentProjectObjectKind, id: string) {
      dependencies.objects.set(`${projectId}:${kind}:${id}`, { projectId, kind, id });
    },
  };
}
export type McpDispatch = ReturnType<typeof createMcpDispatch>;
