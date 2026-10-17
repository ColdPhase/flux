import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ASSISTANT_RUN_EFFECT_TOOLS, AGENT_MCP_ENTRIES, agentScopeRefusal, type AgentMcpPolicy, type AgentOperation, type AgentPeerRequestClass, type AgentScope, type AgentToolCapability } from '@flux/contracts';
import type { McpDispatch } from './mcp-dispatch.js';
import { isAssistantText, redactCall } from './assistant-changes.js';

/**
 * The run-private view of a change tool (F-027 A3, R2): an assistant run names no runtime, standing grant
 * or request class (the run is its authority), its project defaults to the run's place, and the description
 * says what the change does and that some changes wait for the owner. The public schema is unchanged.
 */
const RUN_EFFECT_DESCRIPTIONS: Record<string, string> = {
  flux_create_task: 'Add one task to this project.',
  flux_update_task: 'Change one task at the version you last read (title, outcome, status, blocker, done-when, prerequisites).',
  flux_record_result: 'Record one observed result, optionally finishing one of its tasks at the version you last read.',
  flux_propose_decision: 'Propose one decision. It stays proposed; people decide.',
  flux_create_doc: 'Start one Wiki page in this project.',
  flux_update_doc: 'Save the next version of one Wiki page at the version you last read (the complete new text).',
  flux_create_map: 'Create one shared map in this project.',
  flux_rename_map: 'Rename one map at the version you last read.',
  flux_add_thought: 'Add one thought to a map, optionally linked from another thought.',
  flux_update_thought: 'Change one thought at the version you last read.',
  flux_remove_thought: 'Remove one thought (this always waits for your owner\'s OK).',
  flux_move_thoughts: 'Move thoughts on a map, each at the version you last read.',
  flux_link_thoughts: 'Link two thoughts of one map.',
  flux_unlink_thoughts: 'Remove one link (this always waits for your owner\'s OK).',
  flux_start_conversation: 'Start a conversation in this project.',
  flux_reply_in_conversation: 'Reply in one conversation of this project.',
};
const RUN_NOTE = ' Some changes wait for your owner instead of applying; the result then says so in plain words. Do not retry them.';
const RUN_EFFECTS = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
type ToolOutput = { content?: { type: string; text?: string }[]; isError?: boolean };
/** A waiting or deferred change answers the run in plain words, not as an object. */
function plainWords(output: ToolOutput): ToolOutput {
  const text = output?.content?.[0]?.text;
  if (output?.isError || typeof text !== 'string') return output;
  try {
    const value: unknown = JSON.parse(text);
    if (isAssistantText(value)) return { content: [{ type: 'text', text: value.assistantText }] };
  } catch { /* an ordinary result */ }
  return output;
}

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
  granted?: readonly string[], run?: { projectId: string }) {
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
        if (run && effect && RUN_EFFECTS.has(name)) {
          const original = callback as (...args: unknown[]) => unknown;
          const shape = config.inputSchema as unknown as z.ZodObject<Record<string, z.ZodType>>;
          config = { ...config, description: (RUN_EFFECT_DESCRIPTIONS[name] ?? config.title) + RUN_NOTE,
            inputSchema: shape.omit({ runtimeSessionId: true, grantId: true, peerRequestClass: true })
              .extend({ projectId: z.uuid().optional().describe('This run\'s project; leave it out.') }) as unknown as I };
          callback = (async (args: Record<string, unknown>, extra: unknown) => {
            // AIM-3 redaction before anything is prepared, stored or written (AST-9.2).
            const redacted = redactCall({ ...args, projectId: args.projectId ?? run.projectId });
            return plainWords(await original({ ...redacted, assistantCall: { tool: name, args: redacted } }, extra) as ToolOutput);
          }) as unknown as ToolCallback<I>;
        }
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
