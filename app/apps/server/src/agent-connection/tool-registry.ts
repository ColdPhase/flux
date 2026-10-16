import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { AGENT_MCP_ENTRIES, agentScopeRefusal, type AgentMcpPolicy, type AgentOperation, type AgentPeerRequestClass, type AgentScope, type AgentToolCapability } from '@flux/contracts';
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
/**
 * Capability entries are written only when the corresponding real MCP tool is registered. `bound`, set for
 * a personal run's token only, sees every tool result before it is returned (F-022 "Caps").
 * `granted` is the permissions the person granted (token scopes within the connection's): this is the one
 * place that scopes tools to them (#548). A tool outside the grant is never listed, and a call to it
 * returns a structured refusal naming the missing permission before anything runs or is written.
 */
export function agentToolRegistry(server: McpServer, dispatch: McpDispatch, bound?: (result: unknown) => Promise<unknown>,
  granted?: readonly string[]) {
  const entries = new Map<string, Omit<AgentToolCapability, 'available'>>();
  const handles = new Map<string, { disable(): void }>();
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
          const refusal = granted ? agentScopeRefusal(name, granted) : null;
          if (refusal) return Promise.resolve({ content: [{ type: 'text' as const, text: JSON.stringify(refusal) }], isError: true });
          const output = dispatch.run('tool', name, () => Reflect.apply(target, receiver, args));
          return bound ? Promise.resolve(output).then(bound) : output;
        } });
        const handle = server.registerTool(name, config, guarded);
        if (granted && !granted.includes(requiredScope)) handle.disable();
        handles.set(name, handle);
        entries.set(name, { name, title: config.title, requiredScope, operation: effect?.operation ?? null, classes: effect?.classes ?? [] });
      } };
    },
    capabilities(scopes: readonly AgentScope[], policy: AgentMcpPolicy): AgentToolCapability[] {
      // The listing and bootstrap agree (#548): a tool outside the grant is neither listed nor named here.
      return [...entries.values()].filter((item) => !granted || granted.includes(item.requiredScope)).map((item) => {
        const entry = AGENT_MCP_ENTRIES.find((candidate) => candidate.kind === 'tool' && candidate.name === item.name)!;
        return { ...item, classes: [...item.classes], available: scopes.includes(item.requiredScope)
          && policy.enabledEntryIds.includes(entry.id)
          && entry.requiredCapabilities.every((id) => policy.enabledCapabilityIds.includes(id)) };
      });
    },
    /**
     * Lists and runs only `names` (a personal run's exact tools, F-022 "Agent connection and permissions");
     * every other registered tool is disabled for this request's server, so it is neither listed nor called.
     */
    restrictTo(names: ReadonlySet<string>) {
      for (const [name, handle] of handles) if (!names.has(name)) handle.disable();
    },
    verifyManifest() {
      const declared = AGENT_MCP_ENTRIES.filter((entry) => entry.kind === 'tool').map((entry) => entry.name).sort();
      if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(declared))
        throw new Error('The Flux tool manifest must match every actual registration');
    },
  };
}
export type AgentToolRegistry = ReturnType<typeof agentToolRegistry>;
