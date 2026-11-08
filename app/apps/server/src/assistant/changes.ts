import type { FastifyInstance } from 'fastify';
import {
  ASSISTANT_UNIT_CREATE_VIEW, assistantChangeActionPath, assistantChangeWords, assistantDoneWords, assistantWorkChangeArgs, assistantRunChangesActionPath, assistantRunChangesPath,
  conversationAssistantChangesPath, WORK_LIMITS, type AssistantChange, type AssistantChangeDecision, type AssistantRunUndone,
} from '@flux/contracts';
import { assistantChangeRows, changeGroup, type AssistantChangeInView, type AssistantChangeRow, type DbExecutor, accessReader, type Database } from '@flux/db';
import { assistantWaitLine, ConflictError, ForbiddenError, InvalidInputError, undoSentence, type UndoRecord, DomainError, evaluateProject, isUuid, NotFoundError,
  type Principal } from '@flux/core';
import { CHANGED_SINCE, REMOVAL_OPERATIONS, requireAiOn, undoChange } from './undo.js';
import type { SessionResolver } from '../identity/index.js';
import { expectedVersion } from '../http/commands.js';
import type { AssistantApproval, AssistantCall } from '../agent-connection/assistant-changes.js';
import { assistantCallFingerprint } from '../agent-connection/assistant-changes.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import type { AgentToolRegistry } from '../agent-connection/tool-registry.js';
import { registerAgentWorkActions } from '../agent-connection/work-actions.js';
import { registerAgentMapActions } from '../agent-connection/map-actions.js';
import { registerAgentDocActions } from '../agent-connection/doc-actions.js';
import { registerAgentConversationActions } from '../agent-connection/conversation-actions.js';
import { registerAgentCoworkActions } from '../agent-connection/cowork-actions.js';
import { ASSISTANT_UNIT_CREATE_INPUT } from '../agent-connection/tool-registry.js';

// The owner's side of an agent's changes (F-036 AG-3, AG-7, #855): the change line and Undo on the agent's message, and the
// waiting changes with Approve, Edit, Skip, Delete and Keep. Only the owner sees or decides a waiting change, in their own
// signed-in session: these routes take a browser session only, so no agent, run token or MCP client can reach them, not even
// for its own change. Anyone else gets the same 404 as for a change that does not exist. Approve re-executes exactly the saved
// tool call through the agent executor under the server-owned `owner_approval` purpose: no model, CLI or run token.

const missing = () => new NotFoundError('Assistant change', 'ASSISTANT_CHANGE_NOT_FOUND');
const STALE = 'Changed since you asked';
/** What Approve says when its owner can no longer use the space the change is in: not that the target changed (#930). */
const LOST_SPACE = 'You no longer have access to this space, so this wasn’t made';
/** What a client's unit, transfer or request says when its Approve comes after the claim or session it was made under ended (a 300 s lease). */
const CLAIM_ENDED = 'The claim this was made under has ended, so it can\'t be made now. Ask again with a live claim';
const CLAIM_ENDED_CODES = new Set(['COWORK_CLAIM_LOST', 'AGENT_EXECUTION_UNAVAILABLE', 'RUNTIME_UNAVAILABLE']);
type ToolOutput = { content?: { text?: string }[]; isError?: boolean };
type SavedTool = (args: Record<string, unknown>, extra: unknown) => Promise<ToolOutput>;

/** The change tools' own callbacks, bound to a server-owned approval context, for re-executing one saved call. */
function savedTools(db: Database, claims: FluxMcpClaims): Map<string, SavedTool> {
  const callbacks = new Map<string, SavedTool>();
  const registry = { forAccess: () => ({ registerTool: (name: string, _config: unknown, callback: SavedTool) => { callbacks.set(name, callback); } }) };
  for (const register of [registerAgentWorkActions, registerAgentMapActions, registerAgentDocActions, registerAgentConversationActions])
    register(registry as unknown as AgentToolRegistry, db, claims);
  // The hand-off tool of the same registry: only its run-private view is ever stored, and Approve decodes exactly that (below).
  // (Its recovery-cursor secret serves tools a saved change never calls; the registration only needs a well-formed one.)
  registerAgentCoworkActions(registry as unknown as AgentToolRegistry, db, claims, 'a-saved-change-reads-no-recovery-cursor');
  return callbacks;
}

type Outcome = { ok: true } | { ok: false; code: string; error: string };
/** Re-executes a saved change's exact call on its owner's Approve; the executor repeats every check and compares the target's version. */
export async function reexecuteChange(db: Database, change: AssistantChangeRow, decidedBy: string): Promise<Outcome> {
  const settings = await db.transaction((tx) => assistantChangeRows(tx as DbExecutor).settings(change.ownerUserId, change.agentId));
  const call = change.preparedCommand as AssistantCall | null;
  if (!call || change.runId && !settings || !change.runId && !change.connectionId) return { ok: false, code: 'ASSISTANT_CHANGE_INVALIDATED', error: 'Your assistant is no longer available' };
  const approval: AssistantApproval = { changeId: change.id, runId: change.runId, purpose: 'owner_approval', decidedBy };
  // The assistant's change is re-executed as the assistant; a local client's, as the connection that made it (#859). A client's waiting
  // co-work call also keeps its sign-in, so Approve repeats it as that client; its runtime session and claim must still be live.
  const bearer = !change.runId ? call.bearer : undefined;
  const claims: FluxMcpClaims = { ownerUserId: change.ownerUserId, connectionId: change.runId ? settings!.connectionId : change.connectionId!,
    clientId: bearer?.clientId ?? null, grantReferenceId: bearer?.grantReferenceId ?? null, approval };
  const tool = savedTools(db, claims).get(call.tool);
  if (!tool) return { ok: false, code: 'ASSISTANT_CHANGE_INVALIDATED', error: 'This kind of change is no longer available' };
  // A saved hand-off is decoded by the exact private view it was prepared with: an unknown or unsupported one needs Ask again,
  // and nothing is rebuilt from guessed fields or a bootstrap (R2).
  if (change.runId && call.tool === 'flux_create_unit' && (call.view !== ASSISTANT_UNIT_CREATE_VIEW || !ASSISTANT_UNIT_CREATE_INPUT.safeParse(call.args).success))
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
const undoOf = (row: AssistantChangeRow) => (row.receipt as { undo?: UndoRecord } | null)?.undo ?? null;
const isThreadLine = (row: AssistantChangeRow) => { const plan = undoOf(row)?.plan; return plan?.kind === 'removal' && plan.thread === true; };
/** A line an agent put in a task's thread, once its owner deleted it (TA-3, #938): "Removed by Jonas", not an Undo that restores nothing. */
const threadLineRemoved = (row: AssistantChangeRow, names: Map<string, string>): string | null =>
  row.state === 'undone' && isThreadLine(row) ? `Removed by ${row.decidedBy ? names.get(row.decidedBy) ?? 'its owner' : 'its owner'}` : null;
/** What was done is the message of the conversation, for everyone who can read it; a waiting change or a refusal is the owner's alone. */
const isDone = (row: AssistantChangeRow) => row.state === 'applied' || row.state === 'applied_after_wait' || row.state === 'undone'
  || row.state === 'refused' && !!row.refusal?.startsWith('Skipped');
const runStateOf = (run: { status: string; stopRequestedAt: Date | null } | undefined): AssistantChange['runState'] => {
  if (!run) return 'done';
  if (['queued', 'reading', 'dispatching'].includes(run.status) && !run.stopRequestedAt) return 'working';
  if (run.status === 'stopped' || run.stopRequestedAt) return 'stopped';
  return run.status === 'completed' || run.status === 'truncated' ? 'done' : 'failed';
};
const statusOf = (row: AssistantChangeRow) => {
  const changes = (row.preparedCommand?.args as { changes?: Record<string, unknown> } | undefined)?.changes;
  return typeof changes?.status === 'string' ? changes.status : null;
};

export function assistantChangeUseCases(db: Database, clock: () => Date = () => new Date()) {
  const rows = () => assistantChangeRows(db as DbExecutor);
  const owner = (principal: Principal) => {
    if (principal.kind !== 'human' || !principal.id) throw missing();
    return principal.id;
  };
  /** Whether the viewer may take a change back: the owner, or anyone who may edit in its project (AG-3 "Undo"). */
  async function undoers(principal: Principal | null, list: AssistantChangeRow[]): Promise<(row: AssistantChangeRow) => boolean> {
    const projects = new Map<string, boolean>();
    for (const row of list) {
      if (projects.has(row.projectId)) continue;
      projects.set(row.projectId, principal?.kind === 'human' && (principal.id === row.ownerUserId
        || (await evaluateProject(principal, 'project.write', row.projectId, accessReader(db))).allowed));
    }
    // Taking back a task's creation is the creating agent's owner's alone (#238, the work domain's own rule), so it is no one else's Undo.
    // Likewise the map, result, decision and message no person can remove (#68): only the person whose agent made them takes them back.
    return (row) => principal?.kind === 'human' && (row.operation !== 'work.create' || row.ownerUserId === principal.id)
      && (!REMOVAL_OPERATIONS.has(row.operation) || principal.id === row.ownerUserId) && (principal.id === row.ownerUserId || projects.get(row.projectId) === true);
  }
  async function view(list: AssistantChangeInView[], mayUndo: (row: AssistantChangeRow) => boolean = () => true): Promise<AssistantChange[]> {
    const names = await rows().names(list.flatMap((row) => [row.ownerUserId, row.otherUserId, row.decidedBy].filter((id): id is string => !!id)));
    const states = await rows().runStates([...new Set(list.flatMap((row) => row.runId ? [row.runId] : []))]);
    // A hand-off says where the unit stands now, in the owner's words for the agent: "Codex hasn't started it yet".
    const units = await rows().unitStates(list.flatMap((row) => { const plan = undoOf(row)?.plan; return plan?.kind === 'handoff' ? [plan.unitId] : []; }));
    return list.map((row) => {
      const args = (row.preparedCommand?.args ?? {}) as { changes?: Record<string, unknown> };
      const words = assistantChangeWords(row.operation, assistantWorkChangeArgs(args.changes ?? {}));
      const phrase = `${words.phrase} ${words.noun}`;
      const forOther = row.operation === 'work.create' && row.waitReason === 'others' && row.otherUserId;
      return { id: row.id, runId: changeGroup(row), agentName: row.agentName, projectId: row.projectId, conversationId: row.conversationId, operation: row.operation,
        objectType: row.objectType, objectId: row.objectId, objectTitle: row.objectTitle, state: row.state, waitReason: row.waitReason, phrase, verb: words.verb,
        line: threadLineRemoved(row, names) ?? handoffLine(row, units) ?? assistantWaitLine({ state: row.state, waitReason: row.waitReason, noun: words.noun, operation: row.operation,
          otherName: row.otherUserId ? names.get(row.otherUserId) ?? null : null, refusal: row.refusal,
          decidedByName: (row.state === 'applied_after_wait' || row.state === 'undone') && row.decidedBy ? names.get(row.decidedBy) ?? null : null }),
        forPerson: forOther ? { id: row.otherUserId!, name: names.get(row.otherUserId!) ?? '' } : null,
        done: assistantDoneWords({ operation: row.operation, objectType: row.objectType, objectTitle: row.objectTitle, status: statusOf(row), phrase }),
        runState: runStateOf(row.runId ? states.get(row.runId) : undefined), before: undoOf(row)?.before ?? null, after: undoOf(row)?.after ?? null,
        owner: { id: row.ownerUserId, name: names.get(row.ownerUserId) ?? '' },
        undoable: (row.state === 'applied' || row.state === 'applied_after_wait') && !!undoOf(row) && mayUndo(row),
        decidedBy: row.decidedBy ? { id: row.decidedBy, name: names.get(row.decidedBy) ?? '' } : null,
        version: row.version, createdAt: row.createdAt.toISOString() };
    });
  }
  async function viewOne(row: AssistantChangeRow, viewer: Principal | null = null) {
    const found = (await rows().findInView(row.id))!;
    return (await view([found], viewer ? await undoers(viewer, [found]) : undefined))[0]!;
  }
  /** The owner's own change, or the same 404 for everyone else. */
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
  /**
   * The owner's own removal is theirs to take back only while they can still write where it was made: an owner who was removed from the
   * space, or made a reader, has no say in it any more (#961). Undo of a removal (a line in a task's thread, a map, a result) writes
   * without asking the domain for rights, so the check is made here. Any other change asks the domain, which answers a refused Undo in
   * its own words ("Changed since. Open it"), so it is not turned into a "not found" here.
   */
  async function ownerMayStillUndo(principal: Principal, projectId: string) {
    const access = await evaluateProject(principal, 'project.write', projectId, accessReader(db));
    if (access.allowed) return;
    if (!access.visible) throw missing();
    throw new ForbiddenError('You can read this, but only people who can edit it can undo it', 'ASSISTANT_CHANGE_NOT_EDITABLE');
  }
  async function mayEdit(principal: Principal, row: AssistantChangeRow) {
    if (!isDone(row) || !(await evaluateProject(principal, 'project.read', row.projectId, accessReader(db))).allowed) throw missing();
    if (!(await evaluateProject(principal, 'project.write', row.projectId, accessReader(db))).allowed)
      throw new ForbiddenError('You can read this, but only people who can edit it can undo it', 'ASSISTANT_CHANGE_NOT_EDITABLE');
  }
  async function editableRun(principal: Principal, runId: string) {
    const userId = owner(principal);
    if (!isUuid(runId)) throw missing();
    const list = await rows().forRun(runId);
    if (!list.length) throw missing();
    if (list[0]!.ownerUserId === userId) {
      // The owner's own group, minus the removals made where they can no longer write (#961). Every other change stays: its Undo asks the
      // domain for their rights now and, when they have none, is reported with the rest as "changed since".
      const stillWritable = new Map<string, boolean>();
      for (const row of list) if (REMOVAL_OPERATIONS.has(row.operation) && !stillWritable.has(row.projectId)) stillWritable.set(row.projectId, (await evaluateProject(principal, 'project.write', row.projectId, accessReader(db))).allowed);
      return list.filter((row) => !REMOVAL_OPERATIONS.has(row.operation) || stillWritable.get(row.projectId));
    }
    // Someone else's group: only what was done, and only where the caller may edit (a local client's group can span several projects).
    const done = list.filter(isDone);
    await mayEdit(principal, done[0] ?? list[0]!);
    const editable: typeof list = [];
    for (const row of done) if ((await evaluateProject(principal, 'project.write', row.projectId, accessReader(db))).allowed) editable.push(row);
    return editable;
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
    if (expected !== undefined && expected !== row.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
    if (row.state !== 'waiting') throw new ConflictError('This change is no longer waiting', 'ASSISTANT_CHANGE_DECIDED');
    if (!(await evaluateProject(principal, 'project.write', row.projectId, accessReader(db))).allowed) {
      await refuse(row, LOST_SPACE);
      return { change: await viewOne((await rows().find(row.id))!), message: LOST_SPACE };
    }
    const outcome = await reexecuteChange(db, row, owner(principal));
    if (outcome.ok) return { change: await viewOne((await rows().find(row.id))!), message: null };
    if (outcome.code === 'ASSISTANT_PAUSED') throw new DomainError(409, outcome.code, outcome.error);
    const message = row.operation.startsWith('cowork.') && CLAIM_ENDED_CODES.has(outcome.code) ? CLAIM_ENDED : stale(outcome.code) ? STALE : outcome.error;
    // Stale, invalidated or refused intent is closed: it needs Ask again, never a second Approve.
    await refuse(row, message);
    return { change: await viewOne((await rows().find(row.id))!), message };
  }
  /** One change's Undo; null when it was undone, otherwise the plain words for why not. */
  async function undoOne(principal: Principal, row: AssistantChangeRow): Promise<string | null> {
    const names = await rows().names([row.ownerUserId, owner(principal)]);
    if (row.operation === 'work.create' && row.ownerUserId !== owner(principal)) return `Only ${names.get(row.ownerUserId) ?? 'their owner'} can undo a task their agent added`;
    // Only the agent's owner takes these back, not every editor of the project: nothing else lets a person remove them.
    if (REMOVAL_OPERATIONS.has(row.operation) && owner(principal) !== row.ownerUserId) return `Only ${names.get(row.ownerUserId) ?? 'their owner'} can take back what their agent made`;
    if (REMOVAL_OPERATIONS.has(row.operation)) await requireAiOn(db, row.projectId);
    const result = await undoChange(db, row, { kind: 'human', id: owner(principal) }, names.get(owner(principal)) ?? 'Someone', names.get(row.ownerUserId) ?? 'Someone');
    return result.done ? result.message : result.message ?? CHANGED_SINCE;
  }
  /** Skip (or Keep, for a deletion): the change is not made, and nothing about it waits any more. */
  async function skip(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
    const userId = owner(principal);
    const row = await own(principal, changeId);
    const updated = await db.transaction(async (tx) => {
      const r = assistantChangeRows(tx as DbExecutor);
      const locked = await r.lock(row.id);
      if (!locked) throw missing();
      if (expected !== undefined && expected !== locked.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
      if (locked.state !== 'waiting') return locked;
      return r.update(row.id, { state: 'skipped', waitReason: null, decidedBy: userId, decidedAt: clock() });
    });
    return { change: await viewOne(updated), message: null };
  }

  return {
    /**
     * The conversation's changes: the owner's own, all of them; for everyone else who can read it, only what was done, which is the
     * agent's message with its change line (AG-3). A waiting change or a refusal never leaves its owner.
     */
    async forConversation(principal: Principal, conversationId: string): Promise<{ items: AssistantChange[] }> {
      const userId = owner(principal);
      if (!isUuid(conversationId)) return { items: [] };
      const place = await rows().conversationPlace(conversationId);
      const access = place ? await evaluateProject(principal, 'project.read', place.projectId, accessReader(db)) : null;
      if (!access?.allowed) throw missing();
      // A guest has no AI (AG-2): a change still waiting is not offered to them, since its Approve could only fail and close it. The row
      // stays waiting, so it is offered again if they become a member again.
      const guest = access.actor?.role === 'guest';
      const list = (await rows().forConversationAll(conversationId))
        .filter((row) => isDone(row) || row.ownerUserId === userId && !(guest && row.state === 'waiting'));
      return { items: await view(list, await undoers(principal, list)) };
    },
    async forRun(principal: Principal, runId: string): Promise<{ items: AssistantChange[] }> {
      // A run that made no change has an empty list for its asker, not a 404 (#842: the private answer asks for it every time); anyone else gets the 404.
      if (isUuid(runId) && !(await rows().forRun(runId)).length) {
        if ((await rows().runOwner(runId)) !== owner(principal)) throw missing();
        return { items: [] };
      }
      const all = await ownRun(principal, runId);
      // The same rule as the conversation's: no waiting change for a guest, found by the project the change is in, as in the Inbox.
      const guestIn = new Map<string, boolean>();
      for (const row of all) if (row.state === 'waiting' && !guestIn.has(row.projectId))
        guestIn.set(row.projectId, (await evaluateProject(principal, 'project.read', row.projectId, accessReader(db))).actor?.role === 'guest');
      const list = all.filter((row) => !(row.state === 'waiting' && guestIn.get(row.projectId)));
      return { items: await view(list, await undoers(principal, list)) };
    },
    /** Approve (or Delete) one waiting change. A target changed since applies nothing. */
    async apply(principal: Principal, changeId: string, expected?: number): Promise<AssistantChangeDecision> {
      const decided = await decideApply(principal, await own(principal, changeId), expected);
      if (decided.message === STALE) throw new ConflictError(STALE, 'ASSISTANT_CHANGE_STALE');
      if (decided.message) throw new DomainError(403, 'ASSISTANT_CHANGE_INVALIDATED', decided.message);
      return decided;
    },
    /** Approve all of a run's waiting changes, each with its own checks; each item says what happened. */
    async applyAll(principal: Principal, runId: string): Promise<{ changes: AssistantChangeDecision[] }> {
      const list = (await ownRun(principal, runId)).filter((row) => row.state === 'waiting');
      const changes: AssistantChangeDecision[] = [];
      for (const row of list) {
        try { changes.push(await decideApply(principal, row, row.version)); }
        catch (error) { if (error instanceof DomainError) changes.push({ change: await viewOne((await rows().find(row.id))!), message: error.message }); else throw error; }
      }
      return { changes };
    },
    skip,
    async skipAll(principal: Principal, runId: string): Promise<{ changes: AssistantChangeDecision[] }> {
      const list = (await ownRun(principal, runId)).filter((row) => row.state === 'waiting');
      const changes: AssistantChangeDecision[] = [];
      for (const row of list) changes.push(await skip(principal, row.id));
      return { changes };
    },
    /**
     * [Edit] of a task proposed for another person (AG-3): the owner changes its title before approving. The saved call changes
     * with it, under a new version, so a stale Approve of the earlier words is a version conflict.
     */
    async edit(principal: Principal, changeId: string, expected: number | undefined, title: unknown): Promise<AssistantChangeDecision> {
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed || trimmed.length > WORK_LIMITS.title) throw new InvalidInputError(`A title of 1–${WORK_LIMITS.title} characters is required`);
      const located = await own(principal, changeId);
      const updated = await db.transaction(async (tx) => {
        const r = assistantChangeRows(tx as DbExecutor);
        const row = await r.lock(located.id);
        if (!row) throw missing();
        if (expected !== undefined && expected !== row.version) throw new ConflictError('This change was decided meanwhile', 'ASSISTANT_CHANGE_VERSION_CONFLICT');
        if (row.state !== 'waiting' || row.operation !== 'work.create' || !row.preparedCommand) throw new ConflictError('Only a waiting new task can be edited', 'ASSISTANT_CHANGE_NOT_EDITABLE');
        const call = row.preparedCommand as AssistantCall;
        const task = (call.args.task ?? {}) as Record<string, unknown>;
        const edited: AssistantCall = { ...call, args: { ...call.args, task: { ...task, title: trimmed } } };
        return r.update(row.id, { preparedCommand: edited, fingerprint: assistantCallFingerprint(edited), objectTitle: trimmed.slice(0, 200) });
      });
      return { change: await viewOne(updated), message: null };
    },
    /** Take back one applied change: a new version restoring what the agent changed, if still untouched (AG-3 "Undo"). */
    async undo(principal: Principal, changeId: string): Promise<AssistantChangeDecision> {
      const row = await editable(principal, changeId);
      if (row.ownerUserId === owner(principal) && REMOVAL_OPERATIONS.has(row.operation)) await ownerMayStillUndo(principal, row.projectId);
      const message = await undoOne(principal, row);
      return { change: await viewOne((await rows().find(row.id))!, principal), message };
    },
    /** The message's Undo always means all of it: each undoable change in turn, then "Undid 5 changes. 2 changed since: #4, #7". */
    async undoRun(principal: Principal, runId: string): Promise<AssistantRunUndone> {
      // Only what has something to take back: a change that created nothing (a hand-off that met an existing unit) or that no domain can
      // remove (a result, a decision, a message) is not "changed since"; it is simply not part of an Undo.
      const who = owner(principal);
      const list = (await editableRun(principal, runId)).filter((row) => (row.state === 'applied' || row.state === 'applied_after_wait') && !!undoOf(row)
        && (row.operation !== 'work.create' || row.ownerUserId === who) && (!REMOVAL_OPERATIONS.has(row.operation) || row.ownerUserId === who)
        // A line the run put in a task's thread is taken back at the line (#923), not with the run's other changes.
        && !isThreadLine(row)).reverse();
      const changes: AssistantChangeDecision[] = []; const changedSince: string[] = []; let undone = 0;
      // One refusal for the whole message, before anything is undone, rather than half of it.
      for (const row of list) if (REMOVAL_OPERATIONS.has(row.operation)) { await requireAiOn(db, row.projectId); break; }
      for (const row of list) {
        const message = await undoOne(principal, row);
        if (message === null) undone++; else changedSince.push(row.objectType === 'work' ? row.objectTitle.split(' ')[0]! : row.objectTitle || row.operation);
        changes.push({ change: await viewOne((await rows().find(row.id))!, principal), message });
      }
      return { changes, undone, changedSince, message: undoSentence(undone, changedSince) };
    },
    /**
     * The owner's waiting changes in projects they can still read; the Inbox groups them into one item per run (AG-7). A guest
     * has no AI (AG-2), so nothing of theirs can be approved and nothing waits for them here.
     */
    async inbox(userId: string) {
      const list = await rows().inbox(userId);
      const readable = [];
      for (const row of list) {
        const access = await evaluateProject({ kind: 'human', id: userId }, 'project.read', row.projectId, accessReader(db));
        if (access.allowed && access.actor?.role !== 'guest') readable.push(row);
      }
      return view(readable);
    },
  };
}
/**
 * The owner's decisions. Every route takes the signed-in browser session (`requirePrincipal`, cookies only): an MCP bearer or a run
 * token is never a session, so no agent or local client can approve, edit or skip anything, not even its own waiting change (AG-3).
 */
export function registerAssistantChangeRoutes(app: FastifyInstance, db: Database, sessions: SessionResolver) {
  const changes = assistantChangeUseCases(db);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const noStore = { 'cache-control': 'no-store' };
  app.get<{ Params: { conversationId: string } }>(conversationAssistantChangesPath(':conversationId'), async (request, reply) =>
    reply.headers(noStore).send(await changes.forConversation(await who(request), request.params.conversationId)));
  app.get<{ Params: { runId: string } }>(assistantRunChangesPath(':runId'), async (request, reply) =>
    reply.headers(noStore).send(await changes.forRun(await who(request), request.params.runId)));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'apply'), async (request) => changes.applyAll(await who(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'skip'), async (request) => changes.skipAll(await who(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunChangesActionPath(':runId', 'undo'), async (request) => changes.undoRun(await who(request), request.params.runId));
  const body = { type: 'object', additionalProperties: false, properties: { expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_647 } } } as const;
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'apply'), { schema: { body: { ...body, nullable: true } } }, async (request) =>
    changes.apply(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'skip'), { schema: { body: { ...body, nullable: true } } }, async (request) =>
    changes.skip(await who(request), request.params.changeId, expectedVersion(request)));
  app.post<{ Params: { changeId: string }; Body: { expectedVersion: number; title: string } }>(assistantChangeActionPath(':changeId', 'edit'), { schema: { body: {
    type: 'object', required: ['expectedVersion', 'title'], additionalProperties: false,
    properties: { expectedVersion: body.properties.expectedVersion, title: { type: 'string', minLength: 1, maxLength: WORK_LIMITS.title } } } } }, async (request) =>
    changes.edit(await who(request), request.params.changeId, expectedVersion(request), request.body.title));
  app.post<{ Params: { changeId: string } }>(assistantChangeActionPath(':changeId', 'undo'), async (request) => changes.undo(await who(request), request.params.changeId));
}
