import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { AgentOperation, AgentPeerRequestClass, AgentScope, AgentToolCapability } from '@flux/contracts';

interface ToolConfiguration<I extends z.ZodType> {
  title: string;
  description: string;
  inputSchema: I;
  annotations?: ToolAnnotations;
}
export interface AgentToolRegistrar {
  registerTool<I extends z.ZodType>(name: string, config: ToolConfiguration<I>, callback: ToolCallback<I>): void;
}
/** Capability entries are written only when the corresponding real MCP tool is registered. */
export function agentToolRegistry(server: McpServer) {
  const entries = new Map<string, Omit<AgentToolCapability, 'available'>>();
  return {
    forScope(requiredScope: AgentScope, effect?: { operation: AgentOperation; classes: readonly AgentPeerRequestClass[] }): AgentToolRegistrar {
      return { registerTool<I extends z.ZodType>(name: string, config: ToolConfiguration<I>, callback: ToolCallback<I>) {
        if (entries.has(name)) throw new Error('A Flux tool cannot be registered twice');
        server.registerTool(name, config, callback);
        entries.set(name, { name, title: config.title, requiredScope, operation: effect?.operation ?? null, classes: effect?.classes ?? [] });
      } };
    },
    capabilities(scopes: readonly AgentScope[]): AgentToolCapability[] {
      return [...entries.values()].map((item) => ({ ...item, classes: [...item.classes], available: scopes.includes(item.requiredScope) }));
    },
  };
}
export type AgentToolRegistry = ReturnType<typeof agentToolRegistry>;
