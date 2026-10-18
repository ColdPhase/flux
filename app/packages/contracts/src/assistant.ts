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
 * The change tools an assistant run may be listed (F-027 AST-4, A3 #403): the switch-mapped operations of
 * AST-4's table with their own run-private input (no runtime or standing grant; the run is the authority).
 * Not listed: undo of a created task (A4), the question card, and every other co-work unit tool (claim, renew, release, complete,
 * transfer, requests). The own-agent hand-off `flux_create_unit` is listed with its own run-private input (`assistant-unit-create/v1`) and
 * its own bounded adapter. Never listed (AST-5 6-8): access, decisions' acceptance and anything outside the run's place have no tool at all.
 */
export const ASSISTANT_RUN_EFFECT_TOOLS = [
  'flux_create_task', 'flux_update_task', 'flux_record_result', 'flux_propose_decision', 'flux_create_unit',
  'flux_create_doc', 'flux_update_doc',
  'flux_create_map', 'flux_rename_map', 'flux_add_thought', 'flux_update_thought', 'flux_remove_thought',
  'flux_move_thoughts', 'flux_link_thoughts', 'flux_unlink_thoughts',
  'flux_start_conversation', 'flux_reply_in_conversation',
] as const;

/**
 * The exact Flux tools of one assistant run, from the owner's switches (F-027 AST-4, A2/A3): every read tool
 * the saved S6 policy enables and, with `flux.action.execute` in `scopes`, every enabled change tool of
 * `ASSISTANT_RUN_EFFECT_TOOLS`, sorted. *Only read* lists the reads without the changes (AST-4.3). The same
 * list serves `server` and `runtime` runs, so both engines see the same tools and the MCP route lists
 * exactly these to the run's token.
 */
export function assistantRunTools(policy: Pick<AgentMcpPolicy, 'enabledCapabilityIds' | 'enabledEntryIds'>, scopes: readonly string[]): string[] {
  const effects = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
  return AGENT_MCP_ENTRIES.filter((entry) => entry.kind === 'tool' && scopes.includes(entry.requiredScope)
    && (entry.requiredScope === 'flux.context.read' || entry.requiredScope === 'flux.action.execute' && effects.has(entry.name))
    && policy.enabledEntryIds.includes(entry.id) && entry.requiredCapabilities.every((id) => policy.enabledCapabilityIds.includes(id) && !NOT_FOR_RUNS.has(id)))
    .map((entry) => entry.name).sort();
}

/** The scopes a run token carries for its tools: reads, and changes when any change tool is listed. */
export function assistantRunScopes(tools: readonly string[]): string[] {
  const effects = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
  return tools.some((name) => effects.has(name)) ? ['flux.context.read', 'flux.action.execute'] : ['flux.context.read'];
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

/**
 * The one "Can" sentence (F-027 AST-10 Journey 3): the assistant screen, its panel, the hand-off picker and the
 * agent page all print this text, generated from the same switches, so it can never disagree with them.
 */
export function assistantCanSentence(areas: Readonly<AssistantAreas>, approvalMode: 'act' | 'ask' = 'act'): string {
  const named = (ids: AssistantAreaId[], mode: AssistantAreaMode) => ids.filter((id) => areas[id] === mode);
  const words = { tasks: 'tasks', wiki: 'the Wiki', maps: 'maps' } as const;
  const join = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const parts: string[] = [];
  const edits = named(['tasks', 'wiki', 'maps'], 'edit').map((id) => words[id as keyof typeof words]);
  const reads = named(['tasks', 'wiki', 'maps'], 'read').map((id) => words[id as keyof typeof words]);
  if (edits.length) parts.push(`read and edit ${join(edits)}`);
  if (reads.length) parts.push(`read ${join(reads)}`);
  if (areas.conversations === 'edit') parts.push('reply in conversations');
  else if (areas.conversations === 'read') parts.push('read conversations');
  if (areas.decisions === 'edit') parts.push('suggest decisions');
  else if (areas.decisions === 'read') parts.push('read decisions');
  if (!parts.length) return "Can't do anything yet. Every switch is off.";
  const head = parts.join(', ');
  const ask = approvalMode === 'ask'
    ? 'Asks before changing anything.'
    : 'Asks before removing anything or changing things other people made or are responsible for.';
  return `${head[0]!.toUpperCase()}${head.slice(1)}. ${ask} Can't accept decisions or invite people.`;
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
/** "Tell whoever runs Flux" (F-027 Journey 6): one Needs-you item to the workspace's owners; the body may name the plan (`claude_code`, the default, or `codex`). */
export const assistantOperatorRequestPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/assistant-operator-requests`;
/** Project-scoped join questions lead to the manager's existing Agents request area. */
export const assistantJoinInboxPath = (notificationId: string) => `/inbox/${notificationId}`;

// --- The change log, waiting changes and suggestions (F-027 AST-5/AST-6, A3 #403) ---

export const ASSISTANT_CHANGE_LIMITS = {
  /** A waiting change can be applied for seven days, never longer (AST-5). */
  expiryDays: 7,
  /** Undecided waiting changes move to Inbox ten minutes after the run ends (UX review P2-4). */
  inboxAfterMinutes: 10,
  /** The prepared tool call a waiting change keeps (the CHECK on `prepared_command`). */
  preparedBytes: 65_536,
  /** A background run (a stored schedule or reaction) may change at most this much; an interactive request up to the owner's limit of 20 (AST-6 "Limits"). */
  backgroundChangesPerRun: 10,
} as const;
export type AssistantChangeState = 'applied' | 'waiting' | 'applied_after_wait' | 'not_now' | 'expired' | 'undone' | 'refused';
/** Why a change waits: Ask me first, a removal, another person's thing, a live Wiki typist, the run's limit,
 * outside the owner's rights (a suggestion), or a deferred edit whose page changed meanwhile. */
export type AssistantWaitReason = 'ask' | 'removal' | 'others' | 'live_wiki' | 'limit' | 'outside_rights' | 'conflict';
export type AssistantObjectType = 'work' | 'doc' | 'map' | 'thought' | 'link' | 'message' | 'result' | 'decision';

/** One row of the change log, as its owner sees it. Nobody else sees a waiting change. */
export interface AssistantChange {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  operation: string;
  objectType: AssistantObjectType;
  objectId: string | null;
  /** The object's title or number, for "edit *Suppliers*". */
  objectTitle: string;
  state: AssistantChangeState;
  waitReason: AssistantWaitReason | null;
  /** The phrase and the object's own verb: "close task" and "Close". */
  phrase: string;
  verb: string;
  /** Plain words for a waiting, deferred, suggested, refused or expired change, and where a hand-off stands; null for any other applied one. */
  line: string | null;
  /** A suggestion's recipient, by name, and whether it was sent. */
  suggestTo: { id: string; name: string } | null;
  sent: boolean;
  /** Saved user-facing words of a typed suggestion. */
  preview?: string;
  /** Who approved it ("approved by Ada"), for a change applied after a wait; who took it back, for an undone one. */
  decidedBy: { id: string; name: string } | null;
  /** Whose assistant made it: the message reads "Ada's assistant" for everyone who can read the conversation. Optional for older servers. */
  owner?: { id: string; name: string };
  /** Where the run is: its message (header, Undo) shows once it is no longer working. */
  runState: 'working' | 'done' | 'stopped' | 'failed';
  /** Before and after of what the change did, in words ("Probes", "Calibrate the probes"); null when there is nothing to show. */
  before: string | null;
  after: string | null;
  /** An applied change the assistant can still take back (the domain may still refuse: "Changed since"). */
  undoable: boolean;
  version: number;
  createdAt: string;
  expiresAt: string;
}
export interface AssistantChangeDecision {
  change: AssistantChange;
  /** "Changed since you asked. Ask again", when Apply found the target changed and applied nothing. */
  message: string | null;
}
export interface AssistantChangesDecided { changes: AssistantChangeDecision[] }
/** Undo of a whole run's message: each item's result and the sentence "Undid 5 changes. 2 changed since: #4, #7". */
export interface AssistantRunUndone { changes: AssistantChangeDecision[]; undone: number; changedSince: string[]; message: string }

export const ASSISTANT_CHANGES_PATH = '/api/v1/assistant-changes';
export const conversationAssistantChangesPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-changes`;
/**
 * Who has an assistant working in a conversation right now (F-027 AST-6 "Visible to everyone"): names and nothing else, so everyone who can
 * read the conversation sees "Ada's assistant is working…" with no detail and no Stop. The detail stays with the run's owner.
 */
export const conversationAssistantActivityPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-activity`;
export interface AssistantActivity { working: { ownerId: string; ownerName: string }[] }
/** Project-audience event, identifiers only: an assistant started or stopped working in a conversation. Readers refetch the activity. */
export const ASSISTANT_WORKING_EVENT = 'project.assistant_working.v1';
export const assistantRunChangesPath = (runId: string) => `/api/v1/assistant-runs/${runId}/changes`;
/** `apply` (Apply all), `not-now`, or `inbox` (the owner left the conversation) for a run's waiting changes. */
export const assistantRunChangesActionPath = (runId: string, action: 'apply' | 'not-now' | 'inbox' | 'undo') => `/api/v1/assistant-runs/${runId}/changes/${action}`;
/** `apply`, `not-now`, `send` (a suggestion) or `undo` for one change; the body names its `expectedVersion`. */
export const assistantChangeActionPath = (changeId: string, action: 'apply' | 'not-now' | 'send' | 'undo' | 'accept' | 'dismiss') => `/api/v1/assistant-changes/${changeId}/${action}`;

const PHRASES: Record<string, { phrase: string; verb: string; noun: string }> = {
  'work.create': { phrase: 'add', verb: 'Add', noun: 'task' },
  'work.update': { phrase: 'change', verb: 'Change', noun: 'task' },
  'result.record': { phrase: 'record', verb: 'Record', noun: 'result' },
  'decision.propose': { phrase: 'propose', verb: 'Propose', noun: 'decision' },
  'doc.create': { phrase: 'add', verb: 'Add', noun: 'page' },
  'doc.update': { phrase: 'edit', verb: 'Edit', noun: 'page' },
  'map.create': { phrase: 'add', verb: 'Add', noun: 'map' },
  'map.rename': { phrase: 'rename', verb: 'Rename', noun: 'map' },
  'map.thought.create': { phrase: 'add', verb: 'Add', noun: 'thought' },
  'map.thought.update': { phrase: 'edit', verb: 'Edit', noun: 'thought' },
  'map.thought.delete': { phrase: 'remove', verb: 'Remove', noun: 'thought' },
  'map.positions.update': { phrase: 'move', verb: 'Move', noun: 'thought' },
  'map.link.create': { phrase: 'add', verb: 'Add', noun: 'link' },
  'map.link.delete': { phrase: 'remove', verb: 'Remove', noun: 'link' },
  'conversation.create': { phrase: 'post', verb: 'Post', noun: 'message' },
  'conversation.reply': { phrase: 'post', verb: 'Post', noun: 'message' },
  'cowork.unit.create': { phrase: 'hand off', verb: 'Hand off', noun: 'task' },
};

/** The run-private view of `flux_create_unit` (AST-3 R2): its strict input has no bootstrap runtime or grant. Stored with a waiting hand-off. */
export const ASSISTANT_UNIT_CREATE_VIEW = 'assistant-unit-create/v1';

/** What a task change touches, for its own words: the new status, and the one field when it changed only one. */
export function assistantWorkChangeArgs(changes: Record<string, unknown> | null | undefined): { status?: string; titleOnly: boolean; only?: string } {
  const keys = Object.keys(changes ?? {});
  const status = typeof changes?.status === 'string' ? changes.status : undefined;
  return { ...(status ? { status } : {}), titleOnly: keys.length === 1 && keys[0] === 'title', ...(keys.length === 1 ? { only: keys[0]! } : {}) };
}

const WORK_FIELD_PHRASES: Record<string, { phrase: string; verb: string }> = {
  criteria: { phrase: 'add done-when to', verb: 'Add done-when' },
  dependencyIds: { phrase: 'set prerequisites of', verb: 'Set prerequisites' },
  waitingFor: { phrase: 'set waiting-for of', verb: 'Set waiting-for' },
  /** The tool's own name for it: a saved call keeps the tool's arguments. */
  waitingForUserId: { phrase: 'set waiting-for of', verb: 'Set waiting-for' },
};

/** The object's own verb (UX review P2-5): a finished task is "close", a renamed one "rename". */
export function assistantChangeWords(operation: string, args: { status?: string; titleOnly?: boolean; only?: string } = {}): { phrase: string; verb: string; noun: string } {
  if (operation === 'work.update' && (args.status === 'done')) return { phrase: 'close', verb: 'Close', noun: 'task' };
  if (operation === 'work.update' && args.titleOnly) return { phrase: 'rename', verb: 'Rename', noun: 'task' };
  const field = operation === 'work.update' && args.only ? WORK_FIELD_PHRASES[args.only] : undefined;
  if (field) return { phrase: field.phrase, verb: field.verb, noun: 'task' };
  return PHRASES[operation] ?? { phrase: 'change', verb: 'Apply', noun: 'item' };
}

/** "add 2 tasks, edit 1 page" for a set of changes, in first-seen order. */
export function assistantChangeSummary(changes: readonly Pick<AssistantChange, 'phrase'>[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.phrase, (counts.get(change.phrase) ?? 0) + 1);
  return [...counts].map(([phrase, count]) => {
    const space = phrase.lastIndexOf(' ');
    const verb = phrase.slice(0, space); const noun = phrase.slice(space + 1);
    return `${verb} ${count} ${count === 1 ? noun : `${noun}s`}`;
  }).join(', ');
}

/** The button of a batch: the object's own verb when all agree, *Apply* only for a mix. */
export function assistantBatchVerb(changes: readonly Pick<AssistantChange, 'verb'>[]): string {
  const verbs = new Set(changes.map((change) => change.verb));
  return verbs.size === 1 ? [...verbs][0]! : 'Apply';
}

/** The run message's header: "Done: added 2 tasks, edited 1 page", or "Stopped after 3 changes" (AST-6.4, AST-10.13). */
export function assistantMessageHeader(changes: readonly Pick<AssistantChange, 'phrase' | 'runState'>[]): string {
  if (changes.length && changes[0]!.runState === 'stopped') return `Stopped after ${changes.length} change${changes.length === 1 ? '' : 's'}`;
  return `Done: ${assistantChangeSummary(changes.map((change) => ({ phrase: assistantPastPhrase(change.phrase) })))}`;
}
const PAST: Record<string, string> = { add: 'added', change: 'changed', close: 'closed', rename: 'renamed', record: 'recorded', propose: 'proposed',
  edit: 'edited', remove: 'removed', move: 'moved', post: 'posted', set: 'set', hand: 'handed' };
/** "add task" becomes "added task" for a message about what already happened. */
export function assistantPastPhrase(phrase: string): string {
  const space = phrase.indexOf(' ');
  return `${PAST[phrase.slice(0, space)] ?? phrase.slice(0, space)} ${phrase.slice(space + 1)}`;
}
