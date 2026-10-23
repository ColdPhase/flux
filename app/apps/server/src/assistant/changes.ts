import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ASSISTANT_CHANGE_LIMITS, ASSISTANT_LIMITS, ASSISTANT_UNIT_CREATE_VIEW, assistantChangeActionPath, assistantChangeWords, assistantWorkChangeArgs, assistantRunChangesActionPath, assistantRunChangesPath,
  ASSISTANT_CHANGES_PATH, conversationAssistantActivityPath, conversationAssistantChangesPath, type AssistantActivity, type AssistantChange, type AssistantChangeDecision, type AssistantRunUndone,
} from '@flux/contracts';
import { assistantChangeRows, type AssistantChangeRow, type DbExecutor } from '@flux/db';
import { assistantChangeLine, ConflictError, ForbiddenError, undoSentence, type UndoRecord, createNotification, DomainError, evaluateProject, isUuid, NotFoundError, type Database,
  type Principal } from '@flux/core';
import { CHANGED_SINCE, undoChange } from './undo.js';
import type { SessionResolver } from '../identity/index.js';
import { expectedVersion } from '../http/commands.js';
import { notificationUnitOfWork, pgBossQueue } from '../push/adapters.js';
import { needsYouRows } from '@flux/db';
import type { AssistantApproval, AssistantCall } from '../agent-connection/assistant-changes.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import type { AgentToolRegistry } from '../agent-connection/tool-registry.js';
import { registerAgentWorkActions } from '../agent-connection/work-actions.js';
import { registerAgentMapActions } from '../agent-connection/map-actions.js';
import { registerAgentDocActions } from '../agent-connection/doc-actions.js';
import { registerAgentConversationActions } from '../agent-connection/conversation-actions.js';
import { registerAgentCoworkActions } from '../agent-connection/cowork-actions.js';
import { ASSISTANT_UNIT_CREATE_INPUT } from '../agent-connection/tool-registry.js';

// The owner's side of waiting changes (F-027 AST-5, A3 #403): list, Apply, Apply all, Not now, Send (a
// suggestion), and moving undecided ones to Inbox. Only the owner sees or decides a waiting change; anyone
// else gets the same 404 as for a change that does not exist. Apply re-executes exactly the saved tool call
// through the assistant executor under the server-owned `owner_approval` purpose: no model, CLI or run token.

const missing = () => new NotFoundError('Assistant change', 'ASSISTANT_CHANGE_NOT_FOUND');
const STALE = 'Changed since you asked. Ask again';
type ToolOutput = { content?: { text?: string }[]; isError?: boolean };
type SavedTool = (args: Record<string, unknown>, extra: unknown) => Promise<ToolOutput>;

/** The change tools' own callbacks, bound to a server-owned approval context, for re-executing one saved call. */
function savedTools(db: Database, claims: FluxMcpClaims): Map<string, SavedTool> {
  const callbacks = new Map<string, SavedTool>();
  const registry = { forScope: () => ({ registerTool: (name: string, _config: unknown, callback: SavedTool) => { callbacks.set(name, callback); } }) };
  for (const register of [registerAgentWorkActions, registerAgentMapActions, registerAgentDocActions, registerAgentConversationActions])
    register(registry as unknown as AgentToolRegistry, db, claims);
  // The hand-off tool of the same registry: only its run-private view is ever stored, and Apply decodes exactly that (below).
  // (Its recovery-cursor secret serves tools a saved change never calls; the registration only needs a well-formed one.)
  registerAgentCoworkActions(registry as unknown as AgentToolRegistry, db, claims, 'a-saved-change-reads-no-recovery-cursor');
  return callbacks;
}

type Outcome = { ok: true } | { ok: false; code: string; error: string };
/** Re-executes a saved change's exact call; the executor repeats every check and compares the target's version. */
export async function reexecuteChange(db: Database, change: AssistantChangeRow, purpose: AssistantApproval['purpose'], decidedBy: string | null, suggestion = false): Promise<Outcome> {
  const settings = await db.transaction((tx) => assistantChangeRows(tx as DbExecutor).settings(change.ownerUserId, change.workspaceId));
  const call = change.preparedCommand as AssistantCall | null;
  if (!settings || !call) return { ok: false, code: 'ASSISTANT_CHANGE_INVALIDATED', error: 'Your assistant is no longer available' };
  const claims: FluxMcpClaims = { ownerUserId: change.ownerUserId, connectionId: settings.connectionId, clientId: null, grantReferenceId: null,
    scopes: ['flux.context.read', 'flux.action.execute'], approval: { changeId: change.id, runId: change.runId, purpose, decidedBy, ...(suggestion ? { suggestion: true as const } : {}) } };
  const tool = savedTools(db, claims).get(call.tool);
  if (!tool) return { ok: false, code: 'ASSISTANT_CHANGE_INVALIDATED', error: 'This kind of change is no longer available' };
  // A saved hand-off is decoded by the exact private view it was prepared with: an unknown or unsupported one needs Ask again,
  // and nothing is rebuilt from guessed fields or a bootstrap (R2).
  if (call.tool === 'flux_create_unit' && (call.view !== ASSISTANT_UNIT_CREATE_VIEW || !ASSISTANT_UNIT_CREATE_INPUT.safeParse(call.args).success))
    return { ok: false, code: 'ASSISTANT_CHANGE_INVALIDATED', error: 'This hand-off can no longer be applied. Ask again' };
  const output = await tool({ ...call.args, assistantCall: call }, {});
  if (!output.isError) return { ok: true };
  try {
    const parsed = JSON.parse(output.content?.[0]?.text ?? '{}') as { code?: string; error?: string };
    return { ok: false, code: parsed.code ?? 'MCP_TOOL_UNAVAILABLE', error: parsed.error ?? 'Not applied' };
  } catch { return { ok: false, code: 'MCP_TOOL_UNAVAILABLE', error: 'Not applied' }; }
}
const stale = (code: string) => /VERSION_CONFLICT|STALE|CHANGED|DOC_UNCHANGED|NOT_FOUND/.test(code) && code !== 'ASSISTANT_CHANGE_UNAVAILABLE';

/** Where a hand-off's unit stands, for the row of the run's message; null for every other change. */
function handoffLine(row: AssistantChangeRow, units: Map<string, { state: string; generation: number }>): string | null {
  const plan = undoOf(row)?.plan;
  if (row.state !== 'applied' || plan?.kind !== 'handoff') return null;
  const recipient = (undoOf(row)?.after ?? '').replace(/^Handed to /, '') || 'Your agent';
  const unit = units.get(plan.unitId);
  if (!unit) return null;
  if (unit.state === 'pending' && unit.generation === 0) return `${recipient} hasn't started yet`;
  if (unit.state === 'stopped') return 'Cancelled';
  return unit.state === 'completed' ? `${recipient} finished it` : `${recipient} started`;
}
const creationOwner = (row: AssistantChangeRow) => typeof row.receipt?.acceptedBy === 'string' ? row.receipt.acceptedBy : row.ownerUserId;
const undoOf = (row: AssistantChangeRow) => (row.receipt as { undo?: UndoRecord } | null)?.undo ?? null;
/** What was done is the message of the conversation, for everyone who can read it; a waiting change, a suggestion or a refused Apply is the owner's alone. */
const isDone = (row: AssistantChangeRow) => row.state === 'applied' || row.state === 'applied_after_wait' || row.state === 'undone'
  || row.state === 'refused' && !!row.refusal?.startsWith('Skipped');
const runStateOf = (run: { status: string; stopRequestedAt: Date | null } | undefined): AssistantChange['runState'] => {
  if (!run) return 'done';
  if (['queued', 'reading', 'dispatching'].includes(run.status) && !run.stopRequestedAt) return 'working';
  if (run.status === 'stopped' || run.stopRequestedAt) return 'stopped';
  return run.status === 'completed' || run.status === 'truncated' ? 'done' : 'failed';
};

/** Exact saved words a person reviews before accepting; transport and authority fields never enter the UI. */
async function suggestionPreview(row: AssistantChangeRow, rows: ReturnType<typeof assistantChangeRows>): Promise<string> {
  const args = row.preparedCommand?.args ?? {};
  const labels: Record<string, string> = { title: 'Title', outcome: 'Outcome', status: 'State', blocker: 'Blocked because', criteria: 'Done when', text: 'Text', body: 'Page', label: 'Label', x: 'Across', y: 'Down', width: 'Width', height: 'Height', shape: 'Shape' };
  const out: string[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (labels[key]) out.push(`${labels[key]}: ${Array.isArray(item) ? item.join('\n') : item === null ? '(clear)' : String(item)}`);
      else if (['task', 'changes', 'doc', 'thought', 'link'].includes(key)) collect(item);
    }
  };
  collect(args);
  const changes = args.changes as Record<string, unknown> | undefined;
  if (Array.isArray(changes?.dependencyIds)) {
    const tasks = await Promise.all(changes.dependencyIds.map((id) => rows.work(String(id))));
    out.push(`Prerequisites: ${tasks.map((task) => task ? `#${task.number} ${task.title}` : 'No longer available').join(', ') || '(none)'}`);
  }
  if (changes && 'waitingForUserId' in changes) {
    const id = changes.waitingForUserId;
    out.push(`Waiting for: ${typeof id === 'string' ? (await rows.names([id])).get(id) ?? 'No longer available' : '(nobody)'}`);
  }
  return out.join('\n\n');
}

export function assistantChangeUseCases(db: Database, boss?: Pick<PgBoss, 'send'>, clock: () => Date = () => new Date()) {
  const rows = () => assistantChangeRows(db as DbExecutor);
  const owner = (principal: Principal) => {
    if (principal.kind !== 'human' || !principal.id) throw missing();
    return principal.id;
  };
  /** Whether the viewer may take a change back: the owner, or anyone who may edit in its project (AST-6 "Undo"). */
  async function undoers(principal: Principal | null, list: AssistantChangeRow[]): Promise<(row: AssistantChangeRow) => boolean> {
    const projects = new Map<string, boolean>();
    for (const row of list) {
      if (projects.has(row.projectId)) continue;
      projects.set(row.projectId, principal?.kind === 'human' && (principal.id === row.ownerUserId
        || (await evaluateProject(principal, 'project.write', row.projectId, db)).allowed));
    }
    // Taking back a task's creation is the creating assistant's owner's alone (#238, the work domain's own rule), so it is no one else's Undo.
    return (row) => principal?.kind === 'human' && (row.operation !== 'work.create' || creationOwner(row) === principal.id) && (principal.id === row.ownerUserId || projects.get(row.projectId) === true);
  }
  async function view(list: AssistantChangeRow[], conversations: Map<string, string>, mayUndo: (row: AssistantChangeRow) => boolean = () => true): Promise<AssistantChange[]> {
    const names = await rows().names(list.flatMap((row) => [row.ownerUserId, row.otherUserId, row.suggestToUserId, row.decidedBy].filter((id): id is string => !!id)));
    const settings = new Map<string, number>();
    const states = await rows().runStates([...new Set(list.map((row) => row.runId))]);
    // A hand-off says where the unit stands now, in the owner's words for the agent: "Codex hasn't started it yet".
    const units = await rows().unitStates(list.flatMap((row) => { const plan = undoOf(row)?.plan; return plan?.kind === 'handoff' ? [plan.unitId] : []; }));
    const out: AssistantChange[] = [];
    for (const row of list) {
      const key = `${row.ownerUserId}:${row.workspaceId}`;
      if (!settings.has(key)) settings.set(key, (await rows().settings(row.ownerUserId, row.workspaceId))?.changesPerRun ?? ASSISTANT_LIMITS.changesPerRun.default);
      const args = (row.preparedCommand?.args ?? {}) as { changes?: Record<string, unknown> };
      const changes = args.changes ?? {};
      const words = assistantChangeWords(row.operation, assistantWorkChangeArgs(changes));
      const phrase = `${words.phrase} ${words.noun}`;
      const otherId = row.waitReason === 'outside_rights' ? row.suggestToUserId : row.otherUserId;
      out.push({ id: row.id, runId: row.runId, projectId: row.projectId, conversationId: conversations.get(row.runId) ?? '', operation: row.operation,
        objectType: row.objectType, objectId: row.objectId, objectTitle: row.objectTitle, state: row.state, waitReason: row.waitReason, phrase, verb: words.verb,
        line: row.state === 'applied_after_wait' && row.receipt?.acceptedBy ? `Accepted by ${names.get(row.decidedBy ?? '') ?? 'a person'} · drafted by ${names.get(row.ownerUserId) ?? 'Someone'}'s assistant` : handoffLine(row, units) ?? assistantChangeLine({ state: row.state, waitReason: row.waitReason, phrase, noun: words.noun, objectTitle: row.objectTitle, existing: row.objectId !== null,
          ownerName: names.get(row.ownerUserId) ?? '', otherName: otherId ? names.get(otherId) ?? null : null, limit: settings.get(key)!,
          sent: !!row.sentAt, refusal: row.refusal, decidedByName: (row.state === 'applied_after_wait' || row.state === 'undone') && row.decidedBy ? names.get(row.decidedBy) ?? null : null }),
        runState: runStateOf(states.get(row.runId)), before: undoOf(row)?.before ?? null, after: undoOf(row)?.after ?? null,
        owner: { id: row.ownerUserId, name: names.get(row.ownerUserId) ?? '' },
        undoable: (row.state === 'applied' || row.state === 'applied_after_wait') && !!undoOf(row) && mayUndo(row),
        suggestTo: row.suggestToUserId ? { id: row.suggestToUserId, name: names.get(row.suggestToUserId) ?? '' } : null, sent: !!row.sentAt, preview: await suggestionPreview(row, rows()),
        decidedBy: row.decidedBy ? { id: row.decidedBy, name: names.get(row.decidedBy) ?? '' } : null,
        version: row.version, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() });
    }
    return out;
  }
  async function viewOne(row: AssistantChangeRow, viewer: Principal | null = null) {
    const conversationId = await rows().conversationOf(row.runId);
    return (await view([row], new Map(conversationId ? [[row.runId, conversationId]] : []), viewer ? await undoers(viewer, [row]) : undefined))[0]!;
  }
  /** The owner's own change, or the same 404 for everyone else (AST-5.5). */
  async function own(principal: Principal, changeId: string) {
    const userId = owner(principal);
    if (!isUuid(changeId)) throw missing();
    const row = await rows().find(changeId);
    if (!row || row.ownerUserId !== userId) throw missing();
    return row;
  }
  /**
   * A change to take back: the owner's own, or one that was done in a project the caller may edit. Anyone else gets the same 404 as for
   * a change that does not exist; someone who can read but not edit gets a plain 403.
   */
  async function editable(principal: Principal, changeId: string) {
    const userId = owner(principal);
    if (!isUuid(changeId)) throw missing();
    const row = await rows().find(changeId);
    if (!row) throw missing();
    if (row.ownerUserId !== userId) await mayEdit(principal, row);
    return row;
  }
  async function mayEdit(principal: Principal, row: AssistantChangeRow) {
    if (!isDone(row) || !(await evaluateProject(principal, 'project.read', row.projectId, db)).allowed) throw missing();
    if (!(await evaluateProject(principal, 'project.write', row.projectId, db)).allowed)
      throw new ForbiddenError('You can read this, but only people who can edit it can undo it', 'ASSISTANT_CHANGE_NOT_EDITABLE');
  }
  async function editableRun(principal: Principal, runId: string) {
    const userId = owner(principal);
    if (!isUuid(runId)) throw missing();
    const list = await rows().forRun(runId);
    if (!list.length) throw missing();
    if (list[0]!.ownerUserId !== userId) { await mayEdit(principal, list.find(isDone) ?? list[0]!); return list.filter(isDone); }
    return list;
  }
  async function ownRun(principal: Principal, runId: string) {
    const userId = owner(principal);
    if (!isUuid(runId)) throw missing();
    const list = await rows().forRun(runId);
    if (!list.length || list[0]!.ownerUserId !== userId) throw missing();
    return list;
  }
  const refuse = (row: AssistantChangeRow, refusal: string) => db.transaction(async (tx) => {
    const r = assistantChangeRows(tx as DbExecutor);
    const locked = await r.lock(row.id);
    if (locked?.state === 'waiting') await r.update(row.id, { state: 'refused', waitReason: null, refusal: refusal.slice(0, 500) });
  });

  async function decideApply(principal: Principal, row: AssistantChangeRow, expected: number | undefined): Promise<AssistantChangeDecision> {
    const now = clock();
    if (row.state === 'waiting' && row.expiresAt <= now) {
      await rows().expire(now, row.ownerUserId);
      throw new ConflictError(`Expired: ${(await viewOne((await rows().find(row.id))!)).phrase} · Ask again`, 'ASSISTANT_CHANGE_EXPIRED');
    }
    if (expected !== undefined && expected !== row.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
    if (row.state !== 'waiting') throw new ConflictError('This change is no longer waiting', 'ASSISTANT_CHANGE_DECIDED');
    if (row.waitReason === 'outside_rights') throw new ConflictError('This is a suggestion for someone else; send it to them', 'ASSISTANT_CHANGE_IS_SUGGESTION');
    const outcome = await reexecuteChange(db, row, 'owner_approval', owner(principal));
    if (outcome.ok) return { change: await viewOne((await rows().find(row.id))!), message: null };
    if (outcome.code === 'ASSISTANT_PAUSED') throw new DomainError(409, outcome.code, outcome.error);
    const message = stale(outcome.code) ? STALE : outcome.error;
    // Stale, invalidated or refused intent is closed: it needs Ask again, never a second Apply (R1).
    await refuse(row, message);
    return { change: await viewOne((await rows().find(row.id))!), message };
  }
  /** One change's Undo; null when it was undone, otherwise the plain words for why not. */
  async function undoOne(principal: Principal, row: AssistantChangeRow): Promise<string | null> {
    const names = await rows().names([row.ownerUserId, creationOwner(row), owner(principal)]);
    if (row.operation === 'work.create' && creationOwner(row) !== owner(principal))
      return row.receipt?.acceptedBy ? `Only ${names.get(creationOwner(row)) ?? 'its creator'} can undo this task's creation` : `Only ${names.get(row.ownerUserId) ?? 'their owner'} can undo a task their assistant added`;
    const result = await undoChange(db, row, { kind: 'human', id: owner(principal) }, names.get(owner(principal)) ?? 'Someone', names.get(row.ownerUserId) ?? 'Someone');
    return result.done ? result.message : result.message ?? CHANGED_SINCE;
  }
  async function notNow(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
    const userId = owner(principal);
    const row = await own(principal, changeId);
    const updated = await db.transaction(async (tx) => {
      const r = assistantChangeRows(tx as DbExecutor);
      const locked = await r.lock(row.id);
      if (!locked) throw missing();
      if (expected !== undefined && expected !== locked.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
      if (locked.state !== 'waiting') return locked;
      return r.update(row.id, { state: 'not_now', waitReason: null, decidedBy: userId, decidedAt: clock() });
    });
    return { change: await viewOne(updated), message: null };
  }

  return {
    /**
     * The conversation's changes: the owner's own, all of them; for everyone else who can read it, only what was done, which is the
     * run's message (AST-6 "Visible to everyone"). A waiting change, a suggestion or a refused Apply never leaves its owner.
     */
    async forConversation(principal: Principal, conversationId: string): Promise<{ items: AssistantChange[] }> {
      const userId = owner(principal);
      if (!isUuid(conversationId)) return { items: [] };
      const place = await rows().conversationPlace(conversationId);
      if (!place || !(await evaluateProject(principal, 'project.read', place.projectId, db)).allowed) throw missing();
      await rows().expire(clock(), userId);
      const list = (await rows().forConversationAll(conversationId)).filter((row) => row.ownerUserId === userId || isDone(row));
      return { items: await view(list, new Map(list.map((row) => [row.runId, row.conversationId])), await undoers(principal, list)) };
    },
    /** The signed-in owner's own latest changes across conversations; nobody can ask for another person's. */
    async recent(principal: Principal, limit: number): Promise<{ items: AssistantChange[] }> {
      const userId = owner(principal);
      await rows().expire(clock(), userId);
      const list = await rows().recent(userId, Math.min(Math.max(limit, 1), 50));
      return { items: await view(list, new Map(list.map((row) => [row.runId, row.conversationId])), await undoers(principal, list)) };
    },
    async forRun(principal: Principal, runId: string): Promise<{ items: AssistantChange[] }> {
      await rows().expire(clock(), owner(principal));
      const list = await ownRun(principal, runId);
      const conversationId = await rows().conversationOf(runId);
      return { items: await view(list, new Map(conversationId ? [[runId, conversationId]] : []), await undoers(principal, list)) };
    },
    /** Apply one waiting change. A target changed since applies nothing (AST-5.4). */
    async apply(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
      const decided = await decideApply(principal, await own(principal, changeId), expected);
      if (decided.message === STALE) throw new ConflictError(STALE, 'ASSISTANT_CHANGE_STALE');
      if (decided.message) throw new DomainError(403, 'ASSISTANT_CHANGE_INVALIDATED', decided.message);
      return decided;
    },
    /** Apply all of a run's waiting changes, each with its own checks; each item says what happened. */
    async applyAll(principal: Principal, runId: string): Promise<{ changes: AssistantChangeDecision[] }> {
      await rows().expire(clock(), owner(principal));
      const all = await ownRun(principal, runId);
      const list = all.filter((row) => row.state === 'waiting' && row.waitReason !== 'outside_rights');
      // One Apply is a fresh write-only allowance: the owner's current limit, never above the run's original one (20; 10 in the
      // background). Surplus stays waiting for the owner's next Apply, so one tap never enlarges the run beyond its bounds.
      const settings = list[0] ? await rows().settings(list[0].ownerUserId, list[0].workspaceId) : null;
      const background = (await rows().runAuthorities([runId])).get(runId) !== 'owner_request';
      const allowance = Math.min(settings?.changesPerRun ?? ASSISTANT_LIMITS.changesPerRun.default, background ? ASSISTANT_CHANGE_LIMITS.backgroundChangesPerRun : ASSISTANT_LIMITS.changesPerRun.max);
      const changes: AssistantChangeDecision[] = [];
      let used = 0;
      for (const row of list) {
        if (used >= allowance) {
          changes.push({ change: await viewOne((await rows().find(row.id))!), message: `Past ${allowance} changes in one Apply. Apply again for the rest` });
          continue;
        }
        try {
          const decided = await decideApply(principal, row, row.version);
          if (decided.change.state === 'applied_after_wait') used += 1;
          changes.push(decided);
        }
        catch (error) { if (error instanceof DomainError) changes.push({ change: await viewOne((await rows().find(row.id))!), message: error.message }); else throw error; }
      }
      return { changes };
    },
    notNow,
    /** Take back one applied change: a new version restoring what the assistant changed, if still untouched (AST-6.2). */
    async undo(principal: Principal, changeId: string): Promise<AssistantChangeDecision> {
      const row = await editable(principal, changeId);
      const message = await undoOne(principal, row);
      return { change: await viewOne((await rows().find(row.id))!, principal), message };
    },
    /** The message's Undo always means all of it: each undoable change in turn, then "Undid 5 changes. 2 changed since: #4, #7". */
    async undoRun(principal: Principal, runId: string): Promise<AssistantRunUndone> {
      // Only what has something to take back: a change that created nothing (a hand-off that met an existing unit) or that no domain can
      // remove (a result, a decision, a message) is not "changed since"; it is simply not part of an Undo.
      const who = owner(principal);
      const list = (await editableRun(principal, runId)).filter((row) => (row.state === 'applied' || row.state === 'applied_after_wait') && !!undoOf(row)
        && (row.operation !== 'work.create' || creationOwner(row) === who)).reverse();
      const changes: AssistantChangeDecision[] = []; const changedSince: string[] = []; let undone = 0;
      for (const row of list) {
        const message = await undoOne(principal, row);
        if (message === null || message === 'Moved to your drafts') undone++; else changedSince.push(row.objectType === 'work' ? row.objectTitle.split(' ')[0]! : row.objectTitle || row.operation);
        changes.push({ change: await viewOne((await rows().find(row.id))!, principal), message });
      }
      return { changes, undone, changedSince, message: undoSentence(undone, changedSince) };
    },
    async notNowAll(principal: Principal, runId: string): Promise<{ changes: AssistantChangeDecision[] }> {
      const list = (await ownRun(principal, runId)).filter((row) => row.state === 'waiting');
      const changes: AssistantChangeDecision[] = [];
      for (const row of list) changes.push(await notNow(principal, row.id));
      return { changes };
    },
    /** The owner leaves the conversation: its undecided waiting changes move to Inbox now (P2-4). */
    async toInbox(principal: Principal, runId: string): Promise<{ moved: number }> {
      await ownRun(principal, runId);
      return { moved: await rows().promote(runId, clock()) };
    },
    async acceptSuggestion(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
      const userId = owner(principal);
      const row = isUuid(changeId) ? await rows().find(changeId) : null;
      if (!row || !row.sentAt || row.suggestToUserId !== userId || row.waitReason !== 'outside_rights') throw missing();
      if (expected !== row.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
      if (row.state !== 'waiting' || row.expiresAt <= clock()) throw new ConflictError('Expired or already decided. Ask again', 'ASSISTANT_CHANGE_EXPIRED');
      const result = await reexecuteChange(db, row, 'owner_approval', userId, true);
      if (!result.ok) {
        if (result.code === 'ASSISTANT_PAUSED') throw new DomainError(409, result.code, result.error);
        const message = stale(result.code) ? STALE : result.error;
        await refuse(row, message);
        throw new DomainError(403, result.code, message);
      }
      return { change: await viewOne((await rows().find(row.id))!, principal), message: null };
    },
    async dismissSuggestion(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
      const userId = owner(principal);
      return db.transaction(async (tx) => {
        const r = assistantChangeRows(tx);
        const located = isUuid(changeId) ? await r.find(changeId) : null;
        if (!located || located.suggestToUserId !== userId || !located.sentAt) throw missing();
        if (!(await evaluateProject(principal, 'project.write', located.projectId, tx, { lock: true })).allowed) throw new ForbiddenError('Only someone who can decide this can dismiss it', 'ASSISTANT_SUGGESTION_AUTHORITY');
        const row = await r.lock(changeId);
        if (!row || !row.sentAt || row.suggestToUserId !== userId || row.state !== 'waiting' || row.waitReason !== 'outside_rights') throw missing();
        if (row.version !== expected) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
        return { change: await viewOne(await r.update(row.id, { state: 'not_now', waitReason: null, decidedBy: userId, decidedAt: clock() })), message: null };
      });
    },
    /** A suggestion reaches the other person only after the owner's tap (AST-5.8): one Needs-you question for them. */
    async send(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
      const userId = owner(principal);
      const located = await own(principal, changeId);
      if (located.expiresAt <= clock()) { await rows().expire(clock(), userId); throw new ConflictError('Expired · Ask again', 'ASSISTANT_CHANGE_EXPIRED'); }
      return db.transaction(async (tx) => {
      const r = assistantChangeRows(tx);
      const row = await r.lock(changeId);
      if (!row || row.ownerUserId !== userId) throw missing();
      if (row.state !== 'waiting' || row.waitReason !== 'outside_rights' || row.sentAt) throw new ConflictError('This suggestion is no longer waiting', 'ASSISTANT_CHANGE_DECIDED');
      if (expected !== undefined && expected !== row.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
      if (row.expiresAt <= clock()) throw new ConflictError('Expired · Ask again', 'ASSISTANT_CHANGE_EXPIRED');
      // The person who owns the thing, when they can decide it; otherwise someone who can write in the project.
      let recipient: string | null = null;
      for (const candidate of [row.suggestToUserId, ...(await needsYouRows(tx).workspaceMembersOfProject(row.projectId, 50)).map((member) => member.id)]) {
        if (!candidate || candidate === userId) continue;
        if ((await evaluateProject({ kind: 'human', id: candidate }, 'project.write', row.projectId, tx, { lock: true })).allowed) { recipient = candidate; break; }
      }
      if (!recipient) throw new ConflictError('Nobody in this project can decide this change', 'ASSISTANT_SUGGESTION_NO_RECIPIENT');
      if (!['work.create', 'work.update', 'doc.create', 'doc.update', 'map.thought.create', 'map.thought.update', 'map.thought.delete', 'map.link.create', 'map.link.delete'].includes(row.operation))
        throw new ForbiddenError('This kind of change cannot be sent as a suggestion', 'ASSISTANT_SUGGESTION_FORBIDDEN');
      const view = await viewOne(row);
      const ownerName = (await rows().names([userId])).get(userId) ?? 'Someone';
      if (!boss) throw new DomainError(503, 'ASSISTANT_SUGGESTION_UNAVAILABLE', 'Suggestions cannot be sent right now');
      const notification = await createNotification(notificationUnitOfWork(tx as Database, pgBossQueue(boss)), {
        userId: recipient, source: { type: 'project', id: row.projectId },
        title: `${ownerName}'s assistant suggests: ${view.phrase}${row.objectTitle ? ` ${row.objectTitle}` : ''}`.slice(0, 200),
        body: `Drafted by ${ownerName}'s assistant · sent by ${ownerName}`,
        aiOrigin: true,
      });
      // The typed suggestion itself is the one Needs-you item; this notification supplies its push only.
      void notification;
      const updated = await r.update(row.id, { suggestToUserId: recipient, sentAt: clock(), decidedBy: userId, decidedAt: clock() });
      return { change: await viewOne(updated), message: null };
      });
    },
    /** Who has an assistant working here, for everyone who can read the conversation: names only (AST-6 "Visible to everyone"). */
    async activity(principal: Principal, conversationId: string): Promise<AssistantActivity> {
      owner(principal);
      if (!isUuid(conversationId)) return { working: [] };
      const place = await rows().conversationPlace(conversationId);
      if (!place || !(await evaluateProject(principal, 'project.read', place.projectId, db)).allowed) throw missing();
      return { working: await rows().workingOwners(conversationId) };
    },
    /** The owner's undecided waiting changes that belong in Inbox now, grouped by run. */
    async inbox(userId: string) {
      const now = clock();
      await rows().expire(now, userId);
      const list = [...await rows().inbox(userId, now, ASSISTANT_CHANGE_LIMITS.inboxAfterMinutes), ...await rows().suggestions(userId, now)];
      const readable = [];
      for (const row of list) if ((await evaluateProject({ kind: 'human', id: userId }, 'project.read', row.projectId, db)).allowed) readable.push(row);
      return view(readable, new Map(list.map((row) => [row.runId, row.conversationId])));
    },
    /** Rechecks live-Wiki deferrals whose typist finished; expires what is past seven days. */
    async sweep(): Promise<void> {
      const now = clock();
      await rows().expire(now);
      for (const row of await rows().deferred(50)) {
        if (row.objectId && await rows().liveTypist(row.objectId, row.ownerUserId)) continue;
        const outcome = await reexecuteChange(db, row, 'owner_deferred_change', null);
        if (outcome.ok) continue;
        await db.transaction(async (tx) => {
          const r = assistantChangeRows(tx as DbExecutor);
          const locked = await r.lock(row.id);
          if (locked?.state !== 'waiting' || locked.waitReason !== 'live_wiki') return;
          // The page changed while they typed: an ordinary waiting change. The owner now asks first: it waits for Apply.
          if (stale(outcome.code)) await r.update(row.id, { waitReason: 'conflict' });
          else if (outcome.code === 'ASSISTANT_NOW_ASKS') await r.update(row.id, { waitReason: 'ask' });
          else await r.update(row.id, { state: 'refused', waitReason: null, refusal: outcome.error.slice(0, 500) });
        });
      }
    },
  };
}
export type AssistantChangeUseCases = ReturnType<typeof assistantChangeUseCases>;

export function registerAssistantChangeRoutes(app: FastifyInstance, db: Database, sessions: SessionResolver, boss: Pick<PgBoss, 'send'>) {
  const changes = assistantChangeUseCases(db, boss);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const noStore = { 'cache-control': 'no-store' };
  app.get<{ Params: { conversationId: string } }>(conversationAssistantChangesPath(':conversationId'), async (request, reply) =>
    reply.headers(noStore).send(await changes.forConversation(await who(request), request.params.conversationId)));
  app.get<{ Querystring: { limit?: string } }>(ASSISTANT_CHANGES_PATH, async (request, reply) =>
    reply.headers(noStore).send(await changes.recent(await who(request), Number.parseInt(request.query.limit ?? '10', 10) || 10)));
  app.get<{ Params: { conversationId: string } }>(conversationAssistantActivityPath(':conversationId'), async (request, reply) =>
    reply.headers(noStore).send(await changes.activity(await who(request), request.params.conversationId)));
  app.get<{ Params: { runId: string } }>(assistantRunChangesPath(':runId'), async (request, reply) =>
    reply.headers(noStore).send(await changes.forRun(await who(request), request.params.runId)));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'apply'), async (request) => changes.applyAll(await who(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'not-now'), async (request) => changes.notNowAll(await who(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'undo'), async (request) => changes.undoRun(await who(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'inbox'), async (request) => changes.toInbox(await who(request), request.params.runId));
  const body = { type: 'object', additionalProperties: false, properties: { expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_647 } } } as const;
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'apply'), { schema: { body: { ...body, nullable: true } } }, async (request) =>
    changes.apply(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'not-now'), { schema: { body: { ...body, nullable: true } } }, async (request) =>
    changes.notNow(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'undo'), async (request) => changes.undo(await who(request), request.params.changeId));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'dismiss'), { schema: { body } }, async (request) =>
    changes.dismissSuggestion(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'accept'), { schema: { body } }, async (request) =>
    changes.acceptSuggestion(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'send'), { schema: { body: { ...body, nullable: true } } }, async (request) =>
    changes.send(await who(request), request.params.changeId, expectedVersion(request)));
  // The live-Wiki deferral rechecks when typists finish, and seven-day expiry, every 15 seconds.
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void changes.sweep().catch((error: unknown) => app.log.error({ error }, 'Assistant change sweep is pending')).finally(() => { sweeping = false; });
  }, 15_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
