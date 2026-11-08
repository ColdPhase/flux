import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ASSISTANT_RUN_EFFECT_TOOLS, ASSISTANT_UNIT_CREATE_VIEW, RUN_NEVER_POSTS, AGENT_PEER_REQUEST_CLASSES, AGENT_TOOLS, type AgentMayDo, type AgentOperation, type AgentPeerRequestClass, type AgentToolAccess, type AgentToolCapability } from '@flux/contracts';
import type { McpDispatch } from './mcp-dispatch.js';
import { isAssistantText, redactCall } from './assistant-changes.js';

/**
 * The run-private view of a change tool (F-027 A3, R2): an assistant run cites no sources (the run is its authority), its project
 * defaults to the run's place, and the description says what the change does and that some changes wait for the owner. A local
 * client sees the public schema, with the same note about waiting.
 */
const RUN_EFFECT_DESCRIPTIONS: Record<string, string> = {
  flux_create_task: 'Add one task to this project. A task for another person (ownerUserId) waits for your owner\'s OK. A task made from a message names it (sourceMessageId). To split a task, make each step a subtask of it (parentTaskId).',
  flux_update_task: 'Change one task at the version you last read (title, outcome, status, blocker, what it waits for, what came of it, done-when, prerequisites).',
  flux_record_result: 'Record one observed result, optionally finishing one of its tasks at the version you last read.',
  flux_propose_decision: 'Propose one decision. It stays proposed; people decide.',
  flux_create_doc: 'Start one Wiki page in this project.',
  flux_update_doc: 'Save the next version of one Wiki page at the version you last read (the complete new text).',
  flux_delete_doc: 'Delete one Wiki page for everyone (deleting always waits for your owner\'s OK).',
  flux_create_map: 'Create one shared map in this project.',
  flux_rename_map: 'Rename one map at the version you last read.',
  flux_add_thought: 'Add one thought to a map, optionally linked from another thought.',
  flux_update_thought: 'Change one thought at the version you last read.',
  flux_remove_thought: 'Remove one thought (deleting always waits for your owner\'s OK).',
  flux_move_thoughts: 'Move thoughts on a map, each at the version you last read.',
  flux_link_thoughts: 'Link two thoughts of one map.',
  flux_unlink_thoughts: 'Remove one link (deleting always waits for your owner\'s OK).',
  flux_create_unit: 'Hand one task to one of your owner\'s own agents (execute, review or plan) at the task version you last read. The authority is this run: '
    + 'there is no bootstrap. The agent still has to claim it itself. It may need your owner\'s OK first; the result then says so.',
};
/**
 * The strict run-private input of `flux_create_unit` (`assistant-unit-create/v1`, R2): exactly the existing intent fields. There is no
 * runtime session or grant, `parent` is the literal null, and supplying anything else (a purpose, a run, an actor, a budget) is an error.
 * The ordinary external schema is unchanged. A waiting hand-off is stored with this view's name and decoded by it on Apply.
 */
export const ASSISTANT_UNIT_CREATE_INPUT = z.strictObject({
  projectId: z.uuid().optional(),
  clientCommandId: z.uuid().describe('New for each change; reuse only to retry it.'),
  peerRequestClass: z.enum(AGENT_PEER_REQUEST_CLASSES).describe('The unit\'s role: execute, review or plan.'),
  taskId: z.uuid().describe('The native task to hand off.'),
  // No pattern here: the definitions travel with every request, so the rule (letters, digits and _ : . -, up to 200) is checked by the adapter.
  unitKey: z.string().min(1).max(200).describe('A stable key for this hand-off, for example "codex-1": letters, digits and _ : . - only.'),
  expectedTaskVersion: z.int().min(1).max(2_147_483_647).describe('The task version you last read.'),
  assignmentConnectionId: z.uuid().describe('One of your owner\'s own agent connections that works in this project.'),
  parent: z.null().describe('Always null: a hand-off from the assistant has no parent unit.'),
});
const RUN_PRIVATE: Record<string, { input: z.ZodType; view: string }> = {
  flux_create_unit: { input: ASSISTANT_UNIT_CREATE_INPUT, view: ASSISTANT_UNIT_CREATE_VIEW },
};
const RUN_EFFECTS = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
/**
 * The change tools a local client shares with a run, its own posting tools (which no run has, #1063), and the co-work tools that can
 * give something to another person's client: a unit assigned or transferred to it waits for the owner's OK like a task for someone
 * else, and taking back a task it created is a deletion, which always waits (C-18). Their other uses do not wait.
 */
const CHANGE_TOOLS = new Set<string>([...ASSISTANT_RUN_EFFECT_TOOLS, ...RUN_NEVER_POSTS, 'flux_transfer_unit', 'flux_undo_task_creation']);
const WAITING_NOTE = ' Some changes wait for your owner\'s OK instead of applying (deleting anything, other people\'s things, a task for someone else, '
  + 'and everything when your owner chose Ask me first): the result then says so in plain words. Do not retry it; carry on with other work.';
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
 * a personal run's token only, sees every tool result before it is returned (F-022 "Caps"). Every tool is listed
 * to every client: what a call may do is decided when it is made, by the owner's rights and the agent's "What it may do"
 * (an agent set to Only read gets plain words for a change), never by a scope or a switch chosen at sign-in (#859).
 */
export function agentToolRegistry(server: McpServer, dispatch: McpDispatch, bound?: (result: unknown) => Promise<unknown>,
  run?: { projectId: string | null }) {
  const entries = new Map<string, Omit<AgentToolCapability, 'available'>>();
  const handles = new Map<string, { disable(): void }>();
  /** Declared tools this server does not offer to this caller: not registered, not listed, and the manifest still adds up. */
  const omitted = new Set<string>();
  return {
    /** A declared tool that this caller does not get (#953: the web read, for a client with no run or while reading the web is off). */
    omit(name: string) {
      if (entries.has(name) || !AGENT_TOOLS.some((item) => item.kind === 'tool' && item.name === name)) throw new Error('Only a declared tool that is not registered can be omitted');
      dispatch.declare('tool', name); // accounted for, so the dispatch's own list check adds up; nothing is registered under it
      omitted.add(name);
    },
    forAccess(access: AgentToolAccess, effect?: { operation: AgentOperation; classes: readonly AgentPeerRequestClass[] }): AgentToolRegistrar {
      return { registerTool<I extends z.ZodType>(name: string, config: ToolConfiguration<I>, callback: ToolCallback<I>) {
        if (entries.has(name)) throw new Error('A Flux tool cannot be registered twice');
        const entry = AGENT_TOOLS.find((item) => item.kind === 'tool' && item.name === name);
        if (!entry || entry.access !== access || entry.operation !== (effect?.operation ?? null))
          throw new Error('A Flux tool must match its exact entry in the tool list');
        dispatch.declare('tool', name);
        if (effect && (run ? RUN_EFFECTS.has(name) : CHANGE_TOOLS.has(name))) {
          const original = callback as (...args: unknown[]) => unknown;
          const private_ = run ? RUN_PRIVATE[name] : undefined;
          if (run) {
            const shape = config.inputSchema as unknown as z.ZodObject<Record<string, z.ZodType>>;
            config = { ...config, description: RUN_EFFECT_DESCRIPTIONS[name] ?? config.title,
              inputSchema: (private_?.input ?? shape.omit({ sources: true })
                .extend({ projectId: z.uuid().optional(), clientCommandId: z.uuid().describe('New for each change; reuse only to retry it.') })) as unknown as I };
          } else config = { ...config, description: `${config.description}${WAITING_NOTE}` };
          callback = (async (args: Record<string, unknown>, extra: unknown) => {
            // AIM-3 redaction before anything is prepared, stored or written (AST-9.2): the call a waiting change keeps is the redacted one.
            const redacted = redactCall({ ...args, ...(run ? { projectId: args.projectId ?? run.projectId } : {}), ...(run && !private_ ? { sources: [] } : {}) });
            return plainWords(await original({ ...redacted, assistantCall: { tool: name, args: redacted, ...(private_ ? { view: private_.view } : {}) } }, extra) as ToolOutput);
          }) as unknown as ToolCallback<I>;
        }
        // Proxy preserves the SDK's schema-dependent callback type and forwards
        // its original receiver/arguments without reconstructing a conditional signature.
        const guarded = new Proxy(callback, { apply(target, receiver, args) {
          const output = dispatch.run('tool', name, () => Reflect.apply(target, receiver, args));
          return bound ? Promise.resolve(output).then(bound) : output;
        } });
        const handle = server.registerTool(name, config, guarded);
        handles.set(name, handle);
        entries.set(name, { name, title: config.title, access, operation: effect?.operation ?? null, classes: effect?.classes ?? [] });
      } };
    },
    /** What the client is told it can do now: a change tool is not available to an agent set to Only read. */
    capabilities(mayDo: AgentMayDo): AgentToolCapability[] {
      return [...entries.values()].map((item) => ({ ...item, classes: [...item.classes], available: item.access === 'read' || mayDo !== 'read' }));
    },
    /**
     * Lists and runs only `names` (a personal run's exact tools, F-022 "Agent connection and permissions");
     * every other registered tool is disabled for this request's server, so it is neither listed nor called.
     */
    restrictTo(names: ReadonlySet<string>) {
      for (const [name, handle] of handles) if (!names.has(name)) handle.disable();
    },
    verifyManifest() {
      const declared = AGENT_TOOLS.filter((entry) => entry.kind === 'tool').map((entry) => entry.name).sort();
      if (JSON.stringify([...entries.keys(), ...omitted].sort()) !== JSON.stringify(declared))
        throw new Error('The Flux tool list must match every actual registration');
    },
  };
}
export type AgentToolRegistry = ReturnType<typeof agentToolRegistry>;
