import { AGENT_TOOLS, type AgentToolEntry } from '@flux/contracts';
import type { AgentProjectObjectKind } from '@flux/core';

export interface McpProjectDependency { projectId: string; action: 'project.read' | 'project.write' }
export interface McpObjectDependency { projectId: string; kind: AgentProjectObjectKind; id: string }
export interface McpDeliveryDependencies {
  projects: Map<string, McpProjectDependency['action']>;
  objects: Map<string, McpObjectDependency>;
  /** Set once any tool, resource or prompt ran: from then on the bytes of the response wait for the live check of the fence. */
  protectedOutput: boolean;
}

/** One verified request owns this context; nothing is a module-global identity cache. */
export function createMcpDispatch() {
  const registered = new Set<string>();
  const dependencies: McpDeliveryDependencies = { projects: new Map(), objects: new Map(), protectedOutput: false };
  const entryOf = (kind: AgentToolEntry['kind'], name: string) => AGENT_TOOLS.find((candidate) => candidate.kind === kind && candidate.name === name);
  return {
    dependencies,
    declare(kind: AgentToolEntry['kind'], name: string) {
      const entry = entryOf(kind, name);
      if (!entry || registered.has(entry.id)) throw new Error('Every MCP registration needs one exact entry in the tool list');
      registered.add(entry.id);
    },
    verifyRegistrations() {
      if (registered.size !== AGENT_TOOLS.length || AGENT_TOOLS.some((entry) => !registered.has(entry.id)))
        throw new Error('The MCP tool list must match every actual tool, resource and prompt');
    },
    run<T>(kind: AgentToolEntry['kind'], name: string, callback: () => T): T {
      if (!entryOf(kind, name)) throw new Error('This tool is not in the tool list');
      dependencies.protectedOutput = true;
      return callback();
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
