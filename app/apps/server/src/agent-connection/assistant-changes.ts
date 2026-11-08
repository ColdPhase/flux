import { createHash, randomUUID } from 'node:crypto';
import { ASSISTANT_CHANGE_LIMITS, assistantChangeWords, assistantWorkChangeArgs, type AgentJsonValue, type AgentMayDo, type AgentOperation, type AgentPostcondition,
  type AssistantObjectType, type AuthenticatedAgentRuntime } from '@flux/contracts';
import { agentExecutionRows, agentProjectObjectRows, assistantChangeRows, assistantRemovalRows, sketchRows, type AssistantChangeRow, type DbExecutor, loadActor, accessReader, type Database, type Transaction } from '@flux/db';
import { ASSISTANT_REFUSALS, changedParagraphs, classifyAssistantChange, DomainError, fieldWords, type UndoRecord, evaluateProject, redactSecrets, requireSpaceAi, SpaceAiOffError } from '@flux/core';
import { nativeConversationsInEventSession } from '../conversation/store.js';
import { nativeDocsInEventSession } from '../docs/adapters.js';
import { nativeMapRoomExists, prepareNativeMap } from '../editing/native-map-journal.js';
import { nativeCapacityRefusal, nativeSketchInEventSession } from '../sketches/adapters.js';
import { nativeWorkInEventSession } from '../work/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';
import type { ActionInput, NativeActions, Produced } from './action-execution.js';
import { agentConnectionInTransaction, type FluxMcpClaims } from './context.js';
import { agentOperationTarget } from './operation-target.js';
import { createAgentConnectionStore } from './store.js';

// The agent's effect path (F-036 AG-3, #855; F-027 A3 #403; mcp-cowork LC-2, #859). A change to a person's things is made
// here by an assistant run or by a local client's connection alike. The authority of a run is the run itself
// (`owner_request`): it is live and the change is within its owner's current rights, which are exactly the agent's. The
// authority of a local client is its verified bearer and its connection, with the same owner rights read at the moment of
// the call. The agent's "What it may do" decides the rest: Only read changes nothing, Ask me first waits for everything, and
// deleting or other people's things always wait. Each call is recorded in the change log in the same transaction, as applied,
// waiting or refused. A waiting change keeps its exact prepared tool call; only the owner's Approve in their own session
// (`owner_approval`) re-executes exactly that call through this executor, with every check repeated and the target's version
// compared. It never revives a run's token, calls a model or reuses a client's token, and no agent has a tool or token for it.

/** The prepared tool call a waiting change keeps: its tool and its run-private arguments, redacted. */
export interface AssistantCall {
  tool: string; args: Record<string, unknown>;
  /** The server-selected run-private view the arguments were validated against (R2); a waiting change decodes with exactly this one. */
  view?: string;
  /**
   * The sign-in of the local client that made a waiting co-work call (clientId and grant reference, which name no secret): Approve
   * repeats the call as that client, under its runtime session and claim, which must still be live. Never set for a run.
   */
  bearer?: { clientId: string | null; grantReferenceId: string | null };
}
/** What the run's tool returns instead of an object when its change waits or is deferred: plain words. */
export interface AssistantText { assistantText: string }
export const isAssistantText = (value: unknown): value is AssistantText =>
  !!value && typeof value === 'object' && typeof (value as AssistantText).assistantText === 'string';

/**
 * A server-owned purpose that re-executes one saved change on its owner's Approve (never a client claim or an agent's call).
 * `runId` is null for a local client's change, whose source is the connection the claims name.
 */
export interface AssistantApproval { changeId: string; runId: string | null; purpose: 'owner_approval'; decidedBy: string }

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
export const assistantCallFingerprint = (call: AssistantCall) =>
  createHash('sha256').update(JSON.stringify(stable({ tool: call.tool, args: call.args }))).digest('hex');
/** AIM-3 redaction applies to every text the assistant writes (AST-9.2): token-shaped strings never commit. */
export function redactCall<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map(redactCall) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactCall(v)])) as T;
  return value;
}

const created = (title: string): UndoRecord => ({ plan: { kind: 'created' }, before: null, after: title || null });
/** A map, a result, a decision or a message the assistant made, which only the assistant's Undo can take back while nobody used it (#68). */
const removal = (title: string, plan: Omit<Extract<UndoRecord['plan'], { kind: 'removal' }>, 'kind'> = {}): UndoRecord => ({ plan: { kind: 'removal', ...plan }, before: null, after: title || null });
const enforceRead = (allowed: boolean) => { if (!allowed) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found'); };
/**
 * What an applied or skipped change keeps of its call: the tool and which fields it changed (a status value only),
 * enough for its words ("close task"). Only a waiting change keeps the full call, because only it is replayed.
 */
export function callSummary(call: AssistantCall): AssistantCall {
  const changes = call.args.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { tool: call.tool, args: {} };
  return { tool: call.tool, args: { changes: Object.fromEntries(Object.entries(changes as Record<string, unknown>)
    .map(([key, value]) => [key, key === 'status' && typeof value === 'string' ? value : true])) } };
}
const invalidated = (message: string) => new DomainError(403, 'ASSISTANT_CHANGE_INVALIDATED', message);
const outsideRunPlace = () => new DomainError(403, 'OUTSIDE_RUN_PLACE', 'An assistant run changes only the project it was asked in');
export const SKIPPED = 'ASSISTANT_CHANGE_SKIPPED';
const isVersionConflict = (error: unknown) => error instanceof DomainError && error.status === 409
  && /VERSION_CONFLICT|STALE|CHANGED/.test(error.code) && error.code !== 'IDEMPOTENCY_CONFLICT';

const OBJECT: Record<string, AssistantObjectType> = {
  'work.create': 'work', 'work.update': 'work', 'result.record': 'result', 'decision.propose': 'decision', 'doc.create': 'doc',
  'doc.update': 'doc', 'map.create': 'map', 'map.rename': 'map', 'map.thought.create': 'thought', 'map.thought.update': 'thought',
  'map.thought.delete': 'thought', 'map.positions.update': 'thought', 'map.link.create': 'link', 'map.link.delete': 'link',
  'conversation.create': 'message', 'conversation.reply': 'message', 'cowork.unit.create': 'work', 'cowork.request': 'work', 'cowork.unit.transfer': 'work', 'work.creation.revert': 'work',
};

interface Target {
  objectType: AssistantObjectType; objectId: string | null; title: string; mine: boolean; removal: boolean;
  /** The other person who made it (a person only), for "Jonas's task", or the person a new task is for. */
  maker: string | null;
  /** A task created for another person: a proposal with [Approve] [Edit] [Skip] (F-036 AG-3). */
  forOther: boolean;
  beforeVersion: number | null;
  /** The owner's agent a hand-off goes to, in the owner's words ("Codex"). */
  recipient?: string;
  /** What Undo needs, read before the change (A4); null when the change cannot be taken back. */
  undo: UndoRecord | null;
  /** The task a result finishes, as it is before: Undo puts it back if nobody touched it since. */
  finishesBefore?: { workId: string; status: string; blocker: string | null };
  words: ReturnType<typeof assistantChangeWords>;
}

/** The task fields an Undo can put back (the names of `UpdateWorkCommand`, with waiting-for by user id). */
const WORK_FIELDS = ['title', 'outcome', 'status', 'blocker', 'waitingFor', 'criteria', 'dependencyIds'];
type WorkView = NonNullable<Awaited<ReturnType<ReturnType<typeof assistantChangeRows>['work']>>>;
/** One task field as Undo compares it: the stored value, waiting-for as the person's id, prerequisites sorted. */
const workField = (work: WorkView, key: string): unknown =>
  key === 'waitingFor' ? work.waitingForUserId : ((work as unknown as Record<string, unknown>)[key] ?? null);

/**
 * What taking back a just-made map, result, decision or message needs, read from what the change really wrote (a trimmed title, the
 * task a result finished and the version it has now). Null for any other change, and for a message in a task's agents' thread.
 */
async function removalUndo(tx: Transaction, operation: string, value: Record<string, unknown>, postconditions: AgentPostcondition[], target: Target,
  agentId: string): Promise<UndoRecord | null> {
  const rows = assistantChangeRows(tx as DbExecutor);
  const made = producedId(value);
  if (!made) return null;
  switch (operation) {
    case 'map.create': {
      const map = await rows.map(made);
      return map ? removal(map.title, { title: map.title }) : null;
    }
    case 'decision.propose': {
      const version = afterVersion(postconditions);
      return removal(target.title, version ? { version } : {});
    }
    case 'result.record': {
      const before = target.finishesBefore;
      const work = before ? await rows.work(before.workId) : null;
      const finished = before && work && before.status !== 'done' && String(workField(work, 'status')) === 'done';
      return removal(target.title, finished ? { finishes: before } : {});
    }
    case 'conversation.create': case 'conversation.reply':
      return await assistantRemovalRows(tx as DbExecutor).messageIsUndoable(made, agentId) ? removal(target.title) : null;
    default: return null;
  }
}

/** The thoughts a change names besides its map: they must be on that map. */
function namedThoughts(operation: string, payload: Record<string, unknown>): string[] {
  switch (operation) {
    case 'map.thought.update': case 'map.thought.delete': return [String(payload.thoughtId)];
    case 'map.link.create': return [String(payload.fromId), String(payload.toId)];
    case 'map.positions.update': return ((payload.moves ?? []) as { id: string }[]).map((move) => move.id);
    default: return [];
  }
}

/**
 * Whether every object a change names is in the run's place, on every change kind. This is the same boundary as a read's
 * `requireObject`, and it comes before anything about the target is read or recorded: an agent's rights are its owner's, but one
 * run reaches only the place it was asked in, so a prompt-injected run reaches one space, not all of them.
 */
async function withinRunPlace(tx: Transaction, operation: AgentOperation, objectId: string | null, payload: Record<string, unknown>,
  place: { workspaceId: string; projectId: string }): Promise<boolean> {
  const objects = agentProjectObjectRows(tx as DbExecutor);
  const rows = assistantChangeRows(tx as DbExecutor);
  const kind = agentOperationTarget(operation);
  if (kind && (!objectId || !await objects.scopeOf(kind, objectId, place, false))) return false;
  const finishes = operation === 'result.record' ? (payload.finishes as { id?: string } | undefined)?.id : undefined;
  if (finishes && !await objects.scopeOf('work', finishes, place, false)) return false;
  const thoughts = [...new Set(namedThoughts(operation, payload))];
  const found = await rows.thoughts(thoughts);
  if (found.length !== thoughts.length || found.some((thought) => thought.sketchId !== objectId)) return false;
  return operation !== 'map.link.delete' || (await rows.link(String(payload.linkId)))?.sketchId === objectId;
}

/** Who made the target and how the change reads, read inside the change's transaction. */
async function describe(tx: Transaction, operation: string, objectId: string | null, payload: Record<string, unknown>,
  owner: string, client: boolean, agentId: string | null = null, projectId: string | null = null): Promise<Target> {
  const rows = assistantChangeRows(tx as DbExecutor);
  // "Yours" is what you or any of your agents made (F-036 Terms), not only this agent.
  const agents = await rows.agentIdsOf(owner);
  const ours = (maker: { userId: string | null; agentId: string | null } | null) => !!maker && (maker.userId === owner || (!!maker.agentId && agents.includes(maker.agentId)));
  const otherPerson = (maker: { userId: string | null; agentId: string | null } | null) => maker?.userId && maker.userId !== owner ? maker.userId : null;
  // A map or thought stays yours only while nobody else has edited it (F-036 Terms), as a page does through `docEditedByOthers`.
  const stillOurs = (object: { userId: string | null; agentId: string | null; editedBy: string[] } | null) => ours(object)
    && !!object && object.editedBy.every((editor) => editor === `human:${owner}` || agents.some((agent) => editor === `agent:${agent}`));
  const base = { objectType: OBJECT[operation] ?? 'work', objectId, title: '', mine: true, removal: false, maker: null, forOther: false, beforeVersion: null,
    undo: null as UndoRecord | null, words: assistantChangeWords(operation) } satisfies Target;
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : '';
  switch (operation) {
    case 'work.create': {
      // A task for another person waits for the owner's OK; one for the owner (or nobody) is created at once.
      const assignee = payload.owner as { kind?: string; id?: string } | null | undefined;
      const forOther = assignee?.kind === 'human' && typeof assignee.id === 'string' && assignee.id !== owner;
      return { ...base, objectId: null, title: text(payload.title), forOther, maker: forOther ? assignee!.id! : null, undo: created(text(payload.title)) };
    }
    case 'doc.create': case 'map.create': case 'decision.propose':
      return { ...base, objectId: null, title: text(payload.title), undo: operation === 'decision.propose' || operation === 'map.create' ? null : created(text(payload.title)) };
    case 'result.record': {
      const finishes = payload.finishes as { id?: string } | undefined;
      const work = finishes?.id ? await rows.work(finishes.id) : null;
      if (!work) return { ...base, objectId: null, title: text(payload.title) };
      const maker = { userId: work.ownerUserId ?? (work.createdByKind === 'human' ? work.createdById : null),
        agentId: work.ownerAgentId ?? (work.createdByKind === 'agent' ? work.createdById : null) };
      return { ...base, objectId: null, title: text(payload.title), mine: ours(maker), maker: otherPerson(maker),
        finishesBefore: { workId: work.id, status: String(workField(work, 'status')), blocker: (workField(work, 'blocker') as string | null) ?? null } };
    }
    case 'work.update': {
      const work = objectId ? await rows.work(objectId) : null;
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const words = assistantChangeWords(operation, assistantWorkChangeArgs(changes));
      if (!work) return { ...base, words, mine: false };
      const fields: Record<string, { before: unknown; after: unknown }> = {};
      for (const key of Object.keys(changes).filter((name) => WORK_FIELDS.includes(name)))
        fields[key] = { before: workField(work, key), after: key === 'waitingFor' ? (changes.waitingFor as { id?: string } | null)?.id ?? null
          : key === 'dependencyIds' ? [...(changes.dependencyIds as string[])].sort() : changes[key] ?? null };
      // Leaving Blocked also clears why and who it waited for: Undo puts them back with the status.
      if (typeof changes.status === 'string' && changes.status !== 'blocked' && work.status === 'blocked')
        for (const key of ['blocker', 'waitingFor']) if (!(key in fields)) fields[key] = { before: workField(work, key), after: null };
      const names = await rows.names([fields.waitingFor?.before, fields.waitingFor?.after].filter((id): id is string => typeof id === 'string'));
      const undo: UndoRecord | null = Object.keys(fields).length && Object.keys(changes).every((key) => WORK_FIELDS.includes(key))
        ? { plan: { kind: 'fields', fields }, ...fieldWords(fields, names) } : null;
      // A task is yours when you or your assistant own it, or, with no owner, made it.
      const maker = work.ownerUserId || work.ownerAgentId ? { userId: work.ownerUserId, agentId: work.ownerAgentId }
        : { userId: work.createdByKind === 'human' ? work.createdById : null, agentId: work.createdByKind === 'agent' ? work.createdById : null };
      return { ...base, words, undo, title: `#${work.number} ${work.title}`.slice(0, 200), mine: ours(maker), maker: otherPerson(maker),
        beforeVersion: typeof payload.expectedVersion === 'number' ? payload.expectedVersion : work.version };
    }
    case 'doc.update': {
      const doc = objectId ? await rows.doc(objectId) : null;
      if (!doc) return { ...base, mine: false };
      const mine = ours(doc) && !await rows.docEditedByOthers(doc.id, owner, agents);
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const names = (['title', 'body', 'state'] as const).filter((key) => typeof changes[key] === 'string' && changes[key] !== (doc as Record<string, unknown>)[key]);
      const words = names.includes('body') ? { before: null, after: (() => { const n = changedParagraphs(doc.body, String(changes.body));
        return `${n} paragraph${n === 1 ? '' : 's'} changed`; })() } : fieldWords(Object.fromEntries(names.map((key) => [key, { before: (doc as Record<string, unknown>)[key], after: changes[key] }])));
      return { ...base, undo: names.length ? { plan: { kind: 'doc', fields: names }, ...words } : null, title: doc.title, mine, maker: otherPerson(doc),
        beforeVersion: typeof payload.expectedVersion === 'number' ? payload.expectedVersion : doc.version };
    }
    case 'map.rename': {
      const map = objectId ? await rows.map(objectId) : null;
      const fields = map && typeof payload.title === 'string' ? { title: { before: map.title, after: payload.title } } : null;
      return { ...base, title: map?.title ?? '', mine: stillOurs(map), maker: otherPerson(map), beforeVersion: map?.version ?? null,
        undo: fields ? { plan: { kind: 'fields', fields }, ...fieldWords(fields) } : null };
    }
    case 'map.thought.create': case 'map.link.create': {
      const map = objectId ? await rows.map(objectId) : null;
      return { ...base, objectId: null, title: operation === 'map.thought.create' ? text(payload.text) : (await rows.thoughts([String(payload.fromId), String(payload.toId)])).map((thought) => thought.text.slice(0, 70)).join(' → ') || map?.title || '', undo: created(operation === 'map.thought.create' ? text(payload.text) : '') };
    }
    case 'map.thought.update': case 'map.thought.delete': {
      const [thought] = await rows.thoughts([String(payload.thoughtId)]);
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const fields = thought ? Object.fromEntries((['text', 'x', 'y'] as const).filter((key) => key in changes && changes[key] !== thought[key])
        .map((key) => [key, { before: thought[key], after: changes[key] }])) : {};
      const undo: UndoRecord | null = operation === 'map.thought.update' && Object.keys(fields).length && Object.keys(changes).every((key) => key in fields)
        ? { plan: { kind: 'fields', fields }, ...fieldWords(fields) } : null;
      return { ...base, undo, objectId: thought?.id ?? null, title: thought?.text.slice(0, 200) ?? '', mine: stillOurs(thought ?? null), maker: otherPerson(thought ?? null),
        removal: operation === 'map.thought.delete', beforeVersion: thought?.version ?? null };
    }
    case 'map.positions.update': {
      const moves = (payload.moves ?? []) as { id: string }[];
      const thoughts = await rows.thoughts(moves.map((move) => move.id));
      const others = thoughts.filter((thought) => !stillOurs(thought));
      const undo: UndoRecord | null = thoughts.length === moves.length ? { plan: { kind: 'positions', moves: moves.map((move) => {
        const old = thoughts.find((item) => item.id === move.id)!; const to = move as unknown as { x: number; y: number };
        return { id: move.id, before: { x: old.x, y: old.y }, after: { x: to.x, y: to.y } };
      }) }, before: null, after: `${moves.length} moved` } : null;
      return { ...base, undo, objectId: null, title: `${moves.length} thought${moves.length === 1 ? '' : 's'}`,
        mine: thoughts.length === moves.length && !others.length, maker: others.map(otherPerson).find(Boolean) ?? null };
    }
    case 'map.link.delete': {
      const link = await rows.link(String(payload.linkId));
      return { ...base, objectId: String(payload.linkId), mine: ours(link), maker: otherPerson(link), removal: true };
    }
    case 'conversation.create': case 'conversation.reply':
      return { ...base, objectId: null, title: text((payload as { body?: unknown }).body).slice(0, 80) };
    case 'work.creation.revert': {
      // Taking back its own unused task is a deletion (AG-3: deleting always waits). Nothing else about the task is read here.
      const work = objectId ? await rows.work(objectId) : null;
      // Only the agent that created it takes it back: another creator's task is refused now, not left waiting for an OK that could not apply.
      if (work && agentId && (work.createdByKind !== 'agent' || work.createdById !== agentId))
        throw new DomainError(403, 'TASK_CREATION_UNDO_FORBIDDEN', 'Only the agent that created this task can take it back');
      return { ...base, title: work ? `#${work.number} ${work.title}`.slice(0, 200) : '', removal: true, mine: true,
        beforeVersion: typeof payload.expectedVersion === 'number' ? payload.expectedVersion : work?.version ?? null };
    }
    case 'cowork.unit.transfer': {
      const to = typeof payload.assignmentConnectionId === 'string' ? await rows.connection(payload.assignmentConnectionId, projectId) : null;
      if (!client || !to || to.computeSource === 'owner_assistant' || to.revokedAt || !to.usable) throw new DomainError(404, 'COWORK_ASSIGNEE_UNAVAILABLE', 'That agent is not available');
      const forOther = to.ownerUserId !== owner;
      return { ...base, objectId, title: `unit to ${to.label}`.slice(0, 200), forOther, maker: forOther ? to.ownerUserId : null, recipient: to.label };
    }
    case 'cowork.request': {
      // A local client asks another person's client for something (C-18, #859): another person's thing, so it waits for the owner's OK.
      const asked = (payload.request ?? {}) as { recipientConnectionId?: unknown; kind?: unknown };
      const recipient = typeof asked.recipientConnectionId === 'string' ? await rows.connection(asked.recipientConnectionId, projectId) : null;
      if (!client || !recipient || recipient.computeSource === 'owner_assistant' || recipient.revokedAt || !recipient.usable)
        throw new DomainError(404, 'COWORK_ASSIGNEE_UNAVAILABLE', 'That agent is not available');
      const forOther = recipient.ownerUserId !== owner;
      return { ...base, objectId, title: `${typeof asked.kind === 'string' ? asked.kind : 'help'} request to ${recipient.label}`.slice(0, 200), forOther,
        maker: forOther ? recipient.ownerUserId : null, recipient: recipient.label };
    }
    case 'cowork.unit.create': {
      if (client) {
        // A local client's child unit for another client (C-18, #859): for another person's client it is another person's thing and waits.
        const task = objectId ? await rows.work(objectId) : null;
        const to = typeof payload.assignmentConnectionId === 'string' ? await rows.connection(payload.assignmentConnectionId, projectId) : null;
        if (!to || to.computeSource === 'owner_assistant' || to.revokedAt || !to.usable) throw new DomainError(404, 'COWORK_ASSIGNEE_UNAVAILABLE', 'That agent is not available');
        const forOther = to.ownerUserId !== owner;
        return { ...base, title: task ? `#${task.number} ${task.title}`.slice(0, 200) : '', forOther, maker: forOther ? to.ownerUserId : null, recipient: to.label,
          beforeVersion: typeof payload.expectedTaskVersion === 'number' ? payload.expectedTaskVersion : task?.version ?? null };
      }
      // A hand-off is to the owner's own other agent only. A foreign or unavailable recipient is refused before anything waits, so no
      // owner Apply can ever be asked to authorize it. The adapter checks it again under its locks when the unit is opened.
      const work = objectId ? await rows.work(objectId) : null;
      const recipient = typeof payload.assignmentConnectionId === 'string' ? await rows.connection(payload.assignmentConnectionId, projectId) : null;
      if (!recipient || recipient.ownerUserId !== owner || recipient.computeSource === 'owner_assistant' || recipient.revokedAt || !recipient.usable)
        throw new DomainError(404, 'COWORK_ASSIGNEE_UNAVAILABLE', 'That agent is not one of yours in this project');
      if (!work) return { ...base, mine: false, words: assistantChangeWords(operation), recipient: recipient.label };
      const maker = work.ownerUserId || work.ownerAgentId ? { userId: work.ownerUserId, agentId: work.ownerAgentId }
        : { userId: work.createdByKind === 'human' ? work.createdById : null, agentId: work.createdByKind === 'agent' ? work.createdById : null };
      return { ...base, title: `#${work.number} ${work.title}`.slice(0, 200), mine: ours(maker), maker: otherPerson(maker), recipient: recipient.label,
        beforeVersion: typeof payload.expectedTaskVersion === 'number' ? payload.expectedTaskVersion : work.version };
    }
    default:
      return { ...base, mine: false };
  }
}

/** What makes or changes a person's things. Coordination (claims, releases, units) touches none, so the waiting rule does not read it. */
const CHANGES_THINGS: ReadonlySet<string> = new Set(['work.create', 'work.update', 'result.record', 'doc.update', 'map.rename', 'map.thought.create',
  'map.thought.update', 'map.thought.delete', 'map.positions.update', 'map.link.create', 'map.link.delete']);

/** Whether this change always waits for the owner's OK (F-036 AG-3): a deletion, or something of another person's. Read inside the change's transaction. */
export async function alwaysWaits(tx: Transaction, operation: string, objectId: string | null, payload: Record<string, unknown>, owner: string): Promise<boolean> {
  if (!CHANGES_THINGS.has(operation)) return false;
  const target = await describe(tx, operation, objectId, payload, owner, false);
  return target.removal || target.forOther || !target.mine;
}

/** The run's change tools use the canonical native commands, as the assistant agent, in this one transaction. */
function natives(tx: Transaction, session: ReturnType<typeof transactionEventSession>, runtime: AuthenticatedAgentRuntime, live: boolean,
  commandId: string, operation: string, fingerprint: string, releases: Set<() => void>): NativeActions {
  return { work: nativeWorkInEventSession(tx, session),
    maps: nativeSketchInEventSession(tx, session, { prepared: live, commandId, operation: `native-agent:${operation}`, fingerprint, retainUntil: (release) => releases.add(release) }),
    docs: nativeDocsInEventSession(tx, session), conversations: nativeConversationsInEventSession(tx, session),
    transaction: tx, events: session, agent: { kind: 'agent', id: runtime.agentId }, runtime,
    async mapCheckpoint(mapId) {
      const map = await sketchRows(tx).findSketch(mapId);
      if (!map) throw new Error('A changed map vanished inside its transaction');
      return { kind: 'map_checkpoint', id: map.id, updatedAt: map.updatedAt.toISOString() };
    } };
}

const afterVersion = (postconditions: AgentPostcondition[]) => {
  for (const condition of postconditions) if ('version' in condition && typeof condition.version === 'number') return condition.version;
  return null;
};
const producedId = (value: Record<string, unknown>) => {
  for (const key of ['workId', 'docId', 'mapId', 'thoughtId', 'linkId', 'resultId', 'decisionId', 'messageId'])
    if (typeof value[key] === 'string') return value[key] as string;
  return null;
};

type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof assistantChangeRows>['lockRun']>>>;
type ClientRow = NonNullable<Awaited<ReturnType<ReturnType<typeof assistantChangeRows>['lockClient']>>>;
interface Authority {
  runtime: AuthenticatedAgentRuntime; workspaceId: string; agentId: string;
  /** The assistant's run; null for a local client's change. */
  run: RunRow | null;
  /** The agent's "What it may do", read with its connection row held. */
  mayDo: AgentMayDo;
  /** The owner can make this change now: the agent's rights are exactly the owner's (F-036 AG-3). */
  ownerCanWrite: boolean;
  /** Where it ran and who pays, in the receipt's words ("Your Claude plan"; a local client uses its owner's own): recorded with the receipt (AST-6.6). */
  engine: string; payer: string;
}

/** The checks every agent change repeats, live: the binding, the S6 entry, the place and the owner's current rights. */
async function currentAuthority(tx: Transaction, claims: FluxMcpClaims, projectId: string, tool: string, run: RunRow | null, client: ClientRow | null,
  context: Awaited<ReturnType<typeof agentConnectionInTransaction>> | null, approval: AssistantApproval | undefined, prepared: AssistantChangeRow | null): Promise<Authority> {
  const rows = assistantChangeRows(tx as DbExecutor);
  let agentId: string; let workspaceId: string;
  // The owner's own rights now, which are the agent's: outside them nothing can be changed or prepared (AG-3).
  const ownerCanWrite = (await evaluateProject({ kind: 'human', id: claims.ownerUserId }, 'project.write', projectId, accessReader(tx), { lock: true })).allowed;
  if (!approval) {
    // The bearer's own token (checked by the caller before any replay): a run in flight, its place, or a client's live binding.
    if (!context) throw invalidated('This change needs its connection');
    agentId = context.principal.id; workspaceId = context.workspaceId;
  } else if (run) {
    const grant = await createAgentConnectionStore(tx).grantForRun(claims.ownerUserId, claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.connection.computeSource !== 'owner_assistant')
      throw invalidated('Your assistant is no longer available');
    agentId = grant.connection.agentId; workspaceId = grant.connection.workspaceId;
    const actor = await loadActor({ kind: 'agent', id: agentId }, workspaceId, tx, { lock: true });
    if (!actor.active || actor.agent?.ownerUserId !== claims.ownerUserId) throw invalidated('Your assistant is no longer available');
    const checked = await evaluateProject({ kind: 'agent', id: agentId }, 'project.write', projectId, accessReader(tx), { lock: true });
    if (!checked.allowed || checked.project?.workspaceId !== workspaceId) throw invalidated('You can no longer change this');
  } else {
    // A local client's saved change, approved by its owner in their own session: no token is involved, so the connection itself
    // must still be live and still the owner's; the project is the owner's own rights, read again below.
    const connection = await createAgentConnectionStore(tx).resolve(claims.ownerUserId, claims.connectionId);
    if (!connection || connection.computeSource === 'owner_assistant') throw invalidated('This client is no longer available');
    agentId = connection.agentId; workspaceId = connection.workspaceId;
    const actor = await loadActor({ kind: 'agent', id: agentId }, workspaceId, tx, { lock: true });
    if (!actor.active || actor.agent?.ownerUserId !== claims.ownerUserId) throw invalidated('This client is no longer available');
    try { await requireSpaceAi(accessReader(tx), projectId, { lock: true }); }
    catch (error) { if (error instanceof SpaceAiOffError) throw invalidated('AI is off in this space'); throw error; }
    const checked = await evaluateProject({ kind: 'agent', id: agentId }, 'project.write', projectId, accessReader(tx), { lock: true });
    if (!checked.allowed || checked.project?.workspaceId !== workspaceId) throw invalidated('You can no longer change this');
  }
  const now = new Date();
  if (client) {
    // A local client: its connection row, held `FOR SHARE`, is the one place "What it may do" is read.
    if (client.ownerUserId !== claims.ownerUserId || client.revokedAt || client.agentId !== agentId || client.workspaceId !== workspaceId) throw invalidated('This client is no longer available');
    const runtime: AuthenticatedAgentRuntime = Object.freeze({ id: claims.connectionId, workspaceId, connectionId: claims.connectionId, ownerUserId: claims.ownerUserId,
      agentId, clientId: claims.clientId ?? 'flux-client', grantReferenceId: claims.grantReferenceId ?? `flux-client:${claims.connectionId}`, bindingGeneration: 0,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    return { runtime, workspaceId, agentId, run: null, mayDo: client.mayDo, ownerCanWrite, engine: 'client', payer: 'Your own client' };
  }
  if (!run || run.ownerUserId !== claims.ownerUserId || run.projectId !== projectId || run.agentId !== agentId) throw invalidated('This request is unavailable');
  if (approval) {
    // A normally completed or still live source supplies provenance; a stopped, cancelled or failed one supplies nothing.
    if (run.stopRequestedAt || !['reading', 'dispatching', 'completed', 'truncated'].includes(run.status)) throw invalidated('This request was stopped. Ask again');
  }
  const settings = await rows.settings(claims.ownerUserId, agentId);
  if (!settings || settings.connectionId !== claims.connectionId || settings.agentId !== agentId) throw invalidated('This agent is no longer available');
  const enablement = await rows.enablement(claims.ownerUserId, agentId);
  if (!enablement) throw invalidated('This agent was deleted');
  if (prepared && enablement.createdAt > prepared.createdAt) throw invalidated('This agent was set up again since. Ask again');
  const runtime: AuthenticatedAgentRuntime = Object.freeze({ id: run.id, workspaceId, connectionId: claims.connectionId, ownerUserId: claims.ownerUserId,
    agentId, clientId: 'flux-assistant', grantReferenceId: `flux-run:${run.id}`, bindingGeneration: 0,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  return { runtime, workspaceId, agentId, run, mayDo: settings.mayDo, ownerCanWrite, engine: run.engine, payer: enablement.payer };
}

/**
 * The executor of a change tool of a run token or of a local client's bearer, and of a saved change's re-execution on its
 * owner's Approve. Every tool's own native effect is reused unchanged.
 */
export function assistantChangeExecutor(db: Database, claims: FluxMcpClaims) {
  return async function execute<T extends { [key: string]: AgentJsonValue }>(input: ActionInput, operation: AgentOperation,
    objectId: string | null, payload: AgentJsonValue, effect: (native: NativeActions) => Promise<Produced<T>>): Promise<(T & { replayed: boolean }) | AssistantText> {
    const call = input.assistantCall;
    const approval = claims.approval;
    // A run's change names the run; a local client's names its connection (the claims), and is the one with no run.
    const runId = claims.run?.id ?? approval?.runId ?? null;
    if (!call) throw new DomainError(403, 'AGENT_EXECUTION_UNAVAILABLE', 'This change needs its tool call');
    // Anything outside the run's place has no tool to reach it.
    if (claims.run && input.projectId !== claims.run.projectId) throw outsideRunPlace();
    const source = runId ? { runId } : { connectionId: claims.connectionId };
    const fingerprint = assistantCallFingerprint(call);
    const live = operation.startsWith('map.') && objectId !== null && await nativeMapRoomExists(db as DbExecutor, objectId);
    const releases = new Set<() => void>();
    if (live) releases.add(await prepareNativeMap({ claims, command: { operation, objectId, payload } }).catch((error: unknown) => { throw nativeCapacityRefusal(error); }));
    let described: Target | null = null; let authority: Authority | null = null;
    try {
      return await db.transaction(async (tx) => {
        const rows = assistantChangeRows(tx as DbExecutor);
        const session = transactionEventSession(tx);
        // The run row first: concurrent calls of one run serialize here. A client's connection row is held `FOR SHARE`, and one
        // command ID is serialized by its own lock, so a retry never makes the change twice.
        const runRow = runId ? await rows.lockRun(runId) : null;
        const clientRow = runId ? null : await rows.lockClient(claims.connectionId);
        if (!runId) await agentExecutionRows(tx).lockCommand(claims.connectionId, input.clientCommandId);
        const prepared = approval ? await rows.lock(approval.changeId) : null;
        if (approval && (!prepared || prepared.state !== 'waiting' || prepared.fingerprint !== fingerprint || (prepared.runId ?? null) !== runId
          || prepared.ownerUserId !== claims.ownerUserId || !runId && prepared.connectionId !== claims.connectionId))
          throw new DomainError(409, 'ASSISTANT_CHANGE_UNAVAILABLE', 'This change is no longer waiting');
        // A bearer's call is checked first, replay included: a revoked connection, a switched-off tool, another host binding or a space
        // with AI off refuse the retry of a change as they refuse the change (nothing more reaches a token whose grant is gone).
        const context = approval ? null : await agentConnectionInTransaction(tx, claims, 'write', null);
        if (context) {
          enforceRead((await evaluateProject({ kind: 'human', id: claims.ownerUserId }, 'project.read', input.projectId, accessReader(tx), { lock: true })).allowed);
          await context.requireProject(input.projectId, 'project.read');
        }
        if (!approval) {
          const stored = runId ? await rows.byCommand(runId, input.clientCommandId) : await rows.byConnectionCommand(claims.connectionId, input.clientCommandId);
          if (stored) {
            if (stored.fingerprint !== fingerprint) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This command ID belongs to another change');
            if (stored.state === 'applied' && stored.receipt) {
              // A local client's retry observes its stored result only while what it made is still as it left it: after a later change by
              // anyone, the stored outcome no longer describes the object and the retry says so, never a second effect.
              if (!runId) for (const condition of (stored.receipt.postconditions ?? []) as AgentPostcondition[])
                if (!await agentExecutionRows(tx).nativePostcondition(stored.workspaceId, stored.projectId, condition))
                  throw new DomainError(409, 'COMMAND_POSTSTATE_STALE', 'The produced object changed; recover before continuing');
              return { ...(stored.receipt.value as T), replayed: true };
            }
            // The retry of a change that has since been decided says what became of it, not that it waits.
            return { assistantText: stored.state === 'undone' ? 'Your owner undid this change'
              : stored.state === 'applied_after_wait' ? 'Your owner approved this change and it was made'
                : stored.state === 'skipped' ? 'Your owner skipped this change' : stored.refusal ?? 'This change is waiting for your owner\'s OK' };
          }
        }
        authority = await currentAuthority(tx, claims, input.projectId, call.tool, runRow, clientRow, context, approval, prepared);
        // Objects stay in their space: on Approve a miss means the target is gone, which reads "Changed since you asked".
        if (!await withinRunPlace(tx, operation, objectId, (payload ?? {}) as Record<string, unknown>, { workspaceId: authority.workspaceId, projectId: input.projectId }))
          throw approval || !authority.run ? new DomainError(404, 'OBJECT_NOT_FOUND', 'Project object not found') : outsideRunPlace();
        // The exact revisions the change cites are the current ones, and in this space: a private draft or another space's page is never a source.
        const sourceRows = agentExecutionRows(tx);
        for (const source of input.sources ?? []) if (await sourceRows.sourceVersion(authority.workspaceId, input.projectId, source.materialId) !== source.version)
          throw new DomainError(409, 'SOURCE_VERSION_CONFLICT', 'A referenced source changed; recover before continuing');
        const ownerName = (await rows.names([claims.ownerUserId])).get(claims.ownerUserId) ?? 'your owner';
        described = await describe(tx, operation, objectId, (payload ?? {}) as Record<string, unknown>, claims.ownerUserId, !runId, authority.agentId, input.projectId);
        const target = described;
        const phrase = `${target.words.phrase} ${target.words.noun}`;
        if (!approval) {
          // An agent whose "What it may do" is Only read changes nothing (F-036 AG-3).
          const outcome = classifyAssistantChange({ mayDo: authority.mayDo,
            ownerCanWrite: authority.ownerCanWrite, removal: target.removal, mine: target.mine, forOther: target.forOther });
          if (outcome.state === 'refused') {
            // Nothing is prepared for or sent to another person; the agent says so in words (F-036 AG-3 "Never possible").
            const refusal = ASSISTANT_REFUSALS[outcome.reason];
            await rows.insert({ id: randomUUID(), workspaceId: authority.workspaceId, projectId: input.projectId, ...source, ownerUserId: claims.ownerUserId,
              agentId: authority.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
              objectId: target.objectId, objectTitle: target.title, state: 'refused', refusal, preparedCommand: callSummary(call), otherUserId: null,
              beforeVersion: target.beforeVersion, createdAt: new Date() });
            await session.flushEvents();
            return { assistantText: `${refusal}: ${phrase}${target.title ? ` ${target.title}` : ''}.` };
          }
          if (outcome.state === 'waiting') {
            // Measured exactly as the column's CHECK measures it (jsonb text), before anything is written.
            if (await rows.preparedBytes(call) > ASSISTANT_CHANGE_LIMITS.preparedBytes)
              throw new DomainError(413, 'ASSISTANT_CHANGE_TOO_LARGE', 'This change is too large to keep for your OK');
            await rows.insert({ id: randomUUID(), workspaceId: authority.workspaceId, projectId: input.projectId, ...source, ownerUserId: claims.ownerUserId,
              agentId: authority.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
              objectId: target.objectId, objectTitle: target.title, state: 'waiting', waitReason: outcome.reason,
              preparedCommand: !runId && operation.startsWith('cowork.') ? { ...call, bearer: { clientId: claims.clientId, grantReferenceId: claims.grantReferenceId } } : call,
              beforeVersion: target.beforeVersion, otherUserId: target.maker, createdAt: new Date() });
            await session.flushEvents();
            return { assistantText: `Waiting for ${ownerName}'s OK: ${phrase}${target.title ? ` ${target.title}` : ''}.` };
          }
        } else if (authority.mayDo === 'read') {
          throw invalidated('Its "What it may do" is Only read now. Ask again');
        }
        const produced = await effect(natives(tx, session, authority.runtime, live, input.clientCommandId, operation, fingerprint, releases));
        // What the change really wrote (a redacted text differs from the call), so Undo compares with the truth.
        let undo = target.undo;
        // A map, a result, a decision and a message are the agent's own to take back (#68).
        undo = await removalUndo(tx, operation, produced.value as Record<string, unknown>, produced.postconditions, target, authority.agentId) ?? undo;
        if (undo?.plan.kind === 'fields' && objectId) {
          const fields = undo.plan.fields;
          const read: ((key: string) => unknown) | null = operation === 'work.update' ? await rows.work(objectId).then((work) => work && ((key: string) => workField(work, key)))
            : operation === 'map.rename' ? await rows.map(objectId).then((map) => map && ((key: string) => (map as Record<string, unknown>)[key] ?? null))
            : await rows.thoughts([target.objectId ?? objectId]).then(([thought]) => thought && ((key: string) => (thought as unknown as Record<string, unknown>)[key] ?? null));
          if (read) undo = { ...undo, plan: { kind: 'fields', fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { before: value.before, after: read(key) }])) } };
        }
        // A hand-off is taken back by cancelling exactly the unit it opened, and only if this change opened it.
        if (operation === 'cowork.unit.create') {
          const unit = produced.value as { status?: string; unitId?: string; taskId?: string; version?: number };
          undo = unit.status === 'created' && unit.unitId && unit.taskId && unit.version
            ? { plan: { kind: 'handoff', unitId: unit.unitId, taskId: unit.taskId, creationVersion: unit.version }, before: null, after: `Handed to ${target.recipient ?? 'your agent'}` } : null;
        }
        const receipt = { value: produced.value, postconditions: produced.postconditions, ...(undo ? { undo } : {}), authority: approval?.purpose ?? 'owner_request', runId,
          engine: authority.engine, payer: authority.payer, ownerUserId: claims.ownerUserId, agentId: authority.agentId, assistantConnectionId: claims.connectionId, preparedBy: authority.agentId,
          ...(approval ? { approvedBy: approval.decidedBy } : {}) } as unknown as Record<string, unknown>;
        const after = afterVersion(produced.postconditions);
        const createdId = producedId(produced.value as Record<string, unknown>);
        // A local client's message is where its change line shows, with Undo, for everyone who can read the conversation.
        const sentTo = (produced.value as { conversationId?: unknown }).conversationId;
        const conversationId = !runId && target.objectType === 'message' && typeof sentTo === 'string' ? { conversationId: sentTo } : {};
        if (prepared) {
          await rows.update(prepared.id, { state: 'applied_after_wait', waitReason: null, authority: approval!.purpose, receipt, afterVersion: after,
            objectId: prepared.objectId ?? createdId, decidedBy: approval!.decidedBy, decidedAt: new Date(), ...conversationId });
        } else {
          await rows.insert({ id: randomUUID(), workspaceId: authority.workspaceId, projectId: input.projectId, ...source, ...conversationId, ownerUserId: claims.ownerUserId,
            agentId: authority.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
            objectId: target.objectId ?? createdId, objectTitle: target.title, state: 'applied', authority: 'owner_request', preparedCommand: callSummary(call),
            beforeVersion: target.beforeVersion, afterVersion: after, receipt, createdAt: new Date() });
        }
        await session.flushEvents();
        return { ...(produced.value as T), replayed: false };
      });
    } catch (error) {
      // A person changed the object between the run's read and its write: skipped, never retried (AG-3 "Attribution and conflicts").
      // A local client keeps the plain conflict (`VERSION_CONFLICT`, `SOURCE_VERSION_CONFLICT`): it reads the object again, in its editor.
      if (!approval && runId && isVersionConflict(error) && described && authority) {
        const target = described as Target; const held = authority as Authority;
        const who = target.objectId ? await assistantChangeRows(db as DbExecutor).lastActor(target.objectId) : null;
        const label = target.objectType === 'work' ? target.title.split(' ')[0] : target.title;
        const refusal = `Skipped ${label}: ${who?.name ?? 'someone'} changed it while I worked`.slice(0, 500);
        await db.transaction(async (tx) => {
          const rows = assistantChangeRows(tx as DbExecutor);
          if (await rows.byCommand(runId, input.clientCommandId)) return;
          await rows.insert({ id: randomUUID(), workspaceId: held.workspaceId, projectId: input.projectId, ...source, ownerUserId: claims.ownerUserId,
            agentId: held.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
            objectId: target.objectId, objectTitle: target.title, state: 'refused', refusal, preparedCommand: callSummary(call), otherUserId: null, beforeVersion: target.beforeVersion,
            createdAt: new Date() });
        });
        throw new DomainError(409, SKIPPED, refusal);
      }
      throw error;
    } finally { for (const release of releases) release(); }
  };
}
