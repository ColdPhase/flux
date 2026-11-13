import { AGENT_TOOLS, KEY_RUN_ONLY_TOOLS, TOOLS_NOT_FOR_RUNS } from './agent-tools.js';
import type { AgentMayDo } from './agent-proposals.js';
import type { MessageFile } from './files.js';

/**
 * The change tools an assistant run may be listed (A3 #403): its run-private input has no runtime or standing grant; the run
 * is the authority. Not listed: undo of a created task, the question card, and every other co-work unit tool (claim, renew,
 * release, complete, transfer, requests). The own-agent hand-off `flux_create_unit` is listed with its own run-private input
 * (`assistant-unit-create/v1`) and its own bounded adapter. Never listed (F-036 AG-3 "Never possible"): approving, access,
 * decisions' acceptance and anything outside the run's place have no tool at all, and neither has posting in a conversation
 * (`RUN_NEVER_POSTS`, #1063).
 */
export const ASSISTANT_RUN_EFFECT_TOOLS = [
  'flux_create_task', 'flux_update_task', 'flux_propose_decision', 'flux_create_unit',
  'flux_create_doc', 'flux_update_doc', 'flux_delete_doc',
  'flux_create_map', 'flux_rename_map', 'flux_add_thought', 'flux_update_thought', 'flux_remove_thought',
  'flux_move_thoughts', 'flux_link_thoughts', 'flux_unlink_thoughts',
  'flux_attach_image',
  // #1437: a file the run made or wrote, attached to its answer like its asker's own upload.
  'flux_attach_file',
] as const;

/**
 * The run kinds whose answer can carry a picture (#1217, C-59): `/ai` in a space, whose answer is its asker's card with the run's change
 * line, waits and Undo, and which Show everyone posts. A chat, a DM, a schedule and a task's report have no `flux_attach_image`.
 */
export const PICTURE_RUN_KINDS: ReadonlySet<string> = new Set(['ask', 'summarize', 'map_thought']);
export const ATTACH_PICTURE_TOOL = 'flux_attach_image';
/** #1217: a picture attached to a message the run may read, as image input; only for a run whose model sees pictures. */
export const VIEW_PICTURE_TOOL = 'flux_view_image';

/**
 * The tools that post a message in a space's conversation. A run never gets them, whatever its "What it may do" (F-036 AG-3 "Never
 * possible: posting in a conversation with other people", AG-8, C-39; #1063): its answer goes only where Flux puts it, the asker's card
 * (which only their Show everyone posts), the task's discussion for a run on a task, or the agent's private chat. A local client, which
 * only its person prompts, keeps them (LC-2, LC-3) and goes through the same change path.
 */
export const RUN_NEVER_POSTS = ['flux_start_conversation', 'flux_reply_in_conversation'] as const;

/**
 * The exact Flux tools of one assistant run: every read tool the assistant is offered and, unless its "What it may do" is Only
 * read, every change tool of `ASSISTANT_RUN_EFFECT_TOOLS`, sorted (F-036 AG-3). The same list serves `server` and `runtime`
 * runs, so both engines see the same tools and the MCP route lists exactly these to the run's token.
 */
export function assistantRunTools(mayDo: AgentMayDo): string[] {
  const effects = new Set<string>(ASSISTANT_RUN_EFFECT_TOOLS);
  return AGENT_TOOLS.filter((entry) => entry.kind === 'tool' && !TOOLS_NOT_FOR_RUNS.has(entry.name) && !KEY_RUN_ONLY_TOOLS.has(entry.name)
    && (entry.access === 'read' || mayDo !== 'read' && effects.has(entry.name))).map((entry) => entry.name).sort();
}

/** "Tell whoever runs Flux" (F-027 Journey 6): one Needs-you item to the workspace's owners; the body may name the plan (`claude_code`, the default, or `codex`). */
export const assistantOperatorRequestPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/assistant-operator-requests`;

// --- The change log, waiting changes and Undo (F-036 AG-3, AG-7, #855) ---

export const ASSISTANT_CHANGE_LIMITS = {
  /** The prepared tool call a waiting change keeps (the CHECK on `prepared_command`). */
  preparedBytes: 65_536,
} as const;
/** `skipped`: the owner chose Skip (or Keep, for a deletion). */
export type AssistantChangeState = 'applied' | 'waiting' | 'applied_after_wait' | 'skipped' | 'undone' | 'refused';
/**
 * Why a change waits (F-036 AG-3): the agent's "What it may do" is Ask me first, it deletes something, it changes another
 * person's thing (including a task for another person), or, for a run, it would tell another person something (`tells`: a task
 * that waits for them, a decision or result about their task, #1089). Nothing else waits, and nothing waiting expires.
 */
export type AssistantWaitReason = 'ask' | 'removal' | 'others' | 'tells';
export type AssistantObjectType = 'work' | 'doc' | 'map' | 'thought' | 'link' | 'message' | 'decision' | 'picture' | 'file';

/** One row of the change log, as its owner sees it. Nobody else sees a waiting change. */
export interface AssistantChange {
  id: string;
  /** The group Approve all, Skip all and Undo act on: an assistant run, or for a local client its connection (#859). */
  runId: string;
  /** The agent that made it, for the Inbox item: "Assistant", or a local client by its name ("Claude Code on this computer"). */
  agentName: string;
  /** How a local client's change is labelled on its line, "Ada · via Claude Code" (mcp-cowork LC-2): "Claude Code", "Codex" or its own name. Null for the assistant's. */
  via: string | null;
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
  /** Plain words for a waiting or refused change, and where a hand-off stands; null for any other applied one. */
  line: string | null;
  /** A task proposed for another person: who it is for. [Approve] [Edit] [Skip] (F-036 AG-3). */
  forPerson: { id: string; name: string } | null;
  /**
   * Everyone a waiting change of a run would notify, other than the person a task is for (`forPerson`): the one a task would wait for,
   * or the owners of the tasks a decision or result is about (#1089, #1102). Set whatever the change waits for, `others` included; empty
   * otherwise. `after` then holds the words they would read (the task's title and blocker, or the decision's or result's title), so the
   * owner sees what Flux would send, and to whom, before the OK.
   */
  tells: { id: string; name: string }[];
  /** Who approved it ("Approved by Ada"), for a change applied after a wait; who took it back, for an undone one. */
  decidedBy: { id: string; name: string } | null;
  /** Whose agent made it: the message reads "Ada's assistant" for everyone who can read the conversation. */
  owner: { id: string; name: string };
  /** Where the run is: its message (header, Undo) shows once it is no longer working. */
  runState: 'working' | 'done' | 'stopped' | 'failed';
  /** What an applied change did, in past words for the message's change line: "updated the Wiki page Calibration", "moved #4 to Doing". */
  done: string;
  /** Before and after of what the change did, in words ("Probes", "Calibrate the probes"); null when there is nothing to show. */
  before: string | null;
  after: string | null;
  /** A picture the change attached to its run's answer (#1217): the asker's staged file, while it stands (applied and not undone). */
  file?: MessageFile;
  /** An applied change the viewer can still take back (the domain may still refuse: "Changed since"). */
  undoable: boolean;
  version: number;
  createdAt: string;
}
export interface AssistantChangeDecision {
  change: AssistantChange;
  /** "Changed since you asked", when Approve found the target changed and applied nothing. */
  message: string | null;
}
export interface AssistantChangesDecided { changes: AssistantChangeDecision[] }
/** Undo of a whole run's message: each item's result and the sentence "Undid 5 changes. 2 changed since: #4, #7". */
export interface AssistantRunUndone { changes: AssistantChangeDecision[]; undone: number; changedSince: string[]; message: string }
/** `POST …/edit`: the owner changes a task proposed for another person before approving it (F-036 AG-3 [Edit]). */
export interface EditAssistantChangeCommand { expectedVersion: number; title: string }

export const conversationAssistantChangesPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-changes`;
/** What a task, a Wiki page and a map show of their local clients' changes (#868). */
export type AssistantChangeScope = 'work' | 'doc' | 'map';
/**
 * `GET` with `?kind=work|doc|map&id=` of the task, page or map: the changes a local client made to it, applied, with their change line
 * and Undo for everyone who can read it (mcp-cowork LC-2). Waiting changes are the owner's Inbox, and a run's are in its conversation.
 */
export const projectAssistantChangesPath = (projectId: string) => `/api/v1/projects/${projectId}/assistant-changes`;
export const assistantRunChangesPath = (runId: string) => `/api/v1/assistant-runs/${runId}/changes`;
/**
 * `apply` (Approve all), `skip` (Skip all) or `undo` (the Undo on the run's message). Only the owner, in their own signed-in session,
 * approves or skips; no agent or client has a tool or token for it (F-036 AG-3).
 */
export const assistantRunChangesActionPath = (runId: string, action: 'apply' | 'skip' | 'undo') => `/api/v1/assistant-runs/${runId}/changes/${action}`;
/** `apply` (Approve, or Delete for a deletion), `skip` (Skip, or Keep), `edit` (a task for another person) or `undo` for one change. */
export const assistantChangeActionPath = (changeId: string, action: 'apply' | 'skip' | 'edit' | 'undo') => `/api/v1/assistant-changes/${changeId}/${action}`;

const PHRASES: Record<string, { phrase: string; verb: string; noun: string }> = {
  'work.create': { phrase: 'add', verb: 'Add', noun: 'task' },
  'work.update': { phrase: 'change', verb: 'Change', noun: 'task' },
  'decision.propose': { phrase: 'propose', verb: 'Propose', noun: 'decision' },
  'doc.create': { phrase: 'add', verb: 'Add', noun: 'page' },
  'doc.update': { phrase: 'edit', verb: 'Edit', noun: 'page' },
  'doc.delete': { phrase: 'delete', verb: 'Delete', noun: 'page' },
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
  'cowork.unit.transfer': { phrase: 'hand over', verb: 'Hand over', noun: 'unit' },
  'work.creation.revert': { phrase: 'take back', verb: 'Take back', noun: 'task' },
  'answer.picture.attach': { phrase: 'attach', verb: 'Attach', noun: 'picture' },
  'answer.file.attach': { phrase: 'attach', verb: 'Attach', noun: 'file' },
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
  waitingOn: { phrase: 'set waiting-for of', verb: 'Set waiting-for' },
  dueOn: { phrase: 'set due date of', verb: 'Set due date' },
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

const PAST: Record<string, string> = { add: 'added', change: 'changed', close: 'closed', rename: 'renamed', record: 'recorded', propose: 'proposed',
  edit: 'edited', delete: 'deleted', remove: 'removed', move: 'moved', post: 'posted', set: 'set', hand: 'handed', send: 'sent', take: 'took', attach: 'attached' };
/** "add task" becomes "added task" for a message about what already happened. */
export function assistantPastPhrase(phrase: string): string {
  const space = phrase.indexOf(' ');
  return `${PAST[phrase.slice(0, space)] ?? phrase.slice(0, space)} ${phrase.slice(space + 1)}`;
}

const STATUS_WORDS: Record<string, string> = { open: 'To do', in_progress: 'Doing', blocked: 'Blocked', done: 'Done' };
const DONE_NOUNS: Record<string, string> = { work: 'task', doc: 'the Wiki page', map: 'the map', thought: 'the thought', link: 'a link', message: 'a message',
  decision: 'the decision', picture: 'the picture', file: 'the file' };
/**
 * What one applied change did, in past words (F-036 AG-3 change line): "updated the Wiki page Calibration", "moved #4 to Doing",
 * "added task #7 Order sensors". `status` is a task change's new status, when it changed one.
 */
export function assistantDoneWords(change: { operation: string; objectType: AssistantObjectType; objectTitle: string; status?: string | null; phrase: string }): string {
  const title = change.objectTitle.trim();
  const number = change.objectType === 'work' ? title.split(' ')[0] ?? '' : '';
  if (change.operation === 'work.update' && change.status && change.status !== 'done') return `moved ${number || 'a task'} to ${STATUS_WORDS[change.status] ?? change.status}`;
  // The title of a move is already the count, "1 thought" or "3 thoughts" (#1116): not "moved thought 1 thought".
  if (change.operation === 'map.positions.update') return title ? `moved ${title}` : 'moved thoughts';
  if (change.operation === 'doc.update') return `updated ${DONE_NOUNS.doc} ${title}`.trim();
  if (change.operation === 'doc.create') return `added ${DONE_NOUNS.doc} ${title}`.trim();
  if (change.operation === 'doc.delete') return `deleted ${DONE_NOUNS.doc} ${title}`.trim();
  if (change.operation === 'answer.picture.attach') return `attached ${DONE_NOUNS.picture} ${title}`.trim();
  if (change.operation === 'answer.file.attach') return `attached ${title || 'a file'}`.trim();
  const past = assistantPastPhrase(change.phrase);
  return title ? `${past} ${change.objectType === 'work' ? title : `${title}`}` : past;
}

/**
 * The change line of an agent's message (F-036 AG-3): the same change words once, with the count of changes to one object,
 * "Updated the Wiki page Calibration (3 changes) · moved #4 to In progress". The message adds "· Undo" or "· Undone by Ada".
 */
export function assistantChangeLine(changes: readonly Pick<AssistantChange, 'done'>[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.done, (counts.get(change.done) ?? 0) + 1);
  const line = [...counts].map(([done, count]) => count > 1 ? `${done} (${count} changes)` : done).join(' · ');
  return line ? `${line[0]!.toUpperCase()}${line.slice(1)}` : '';
}
