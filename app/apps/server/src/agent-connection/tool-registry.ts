import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { AGENT_MCP_ENTRIES, type AgentMcpPolicy, type AgentOperation, type AgentPeerRequestClass, type AgentScope, type AgentToolCapability } from '@flux/contracts';
import type { McpDispatch } from './mcp-dispatch.js';

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
export function agentToolRegistry(server: McpServer, dispatch: McpDispatch) {
  const entries = new Map<string, Omit<AgentToolCapability, 'available'>>();
  return {
    forScope(requiredScope: AgentScope, effect?: { operation: AgentOperation; classes: readonly AgentPeerRequestClass[] }): AgentToolRegistrar {
      return { registerTool<I extends z.ZodType>(name: string, config: ToolConfiguration<I>, callback: ToolCallback<I>) {
        if (entries.has(name)) throw new Error('A Flux tool cannot be registered twice');
        const entry = AGENT_MCP_ENTRIES.find((item) => item.kind === 'tool' && item.name === name);
        if (!entry || entry.requiredScope !== requiredScope || entry.operation !== (effect?.operation ?? null))
          throw new Error('A Flux tool must match its exact registered permission');
        dispatch.declare('tool', name);
        // Proxy preserves the SDK's schema-dependent callback type and forwards
        // its original receiver/arguments without reconstructing a conditional signature.
        const guarded = new Proxy(callback, { apply(target, receiver, args) {
          return dispatch.run('tool', name, () => Reflect.apply(target, receiver, args));
        } });
        server.registerTool(name, config, guarded);
        entries.set(name, { name, title: config.title, requiredScope, operation: effect?.operation ?? null, classes: effect?.classes ?? [] });
      } };
    },
    capabilities(scopes: readonly AgentScope[], policy: AgentMcpPolicy): AgentToolCapability[] {
      return [...entries.values()].map((item) => {
        const entry = AGENT_MCP_ENTRIES.find((candidate) => candidate.kind === 'tool' && candidate.name === item.name)!;
        return { ...item, classes: [...item.classes], available: scopes.includes(item.requiredScope)
          && policy.enabledEntryIds.includes(entry.id)
          && entry.requiredCapabilities.every((id) => policy.enabledCapabilityIds.includes(id)) };
      });
    },
    verifyManifest() {
      const declared = AGENT_MCP_ENTRIES.filter((entry) => entry.kind === 'tool').map((entry) => entry.name).sort();
      if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(declared))
        throw new Error('The Flux tool manifest must match every actual registration');
    },
  };
}
export type AgentToolRegistry = ReturnType<typeof agentToolRegistry>;
