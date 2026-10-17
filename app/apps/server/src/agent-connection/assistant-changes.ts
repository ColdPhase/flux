import { createHash, randomUUID } from 'node:crypto';
import { AGENT_MCP_ENTRIES, ASSISTANT_CHANGE_LIMITS, assistantChangeWords, type AgentJsonValue, type AgentOperation, type AgentPostcondition,
  type AgentScope, type AssistantObjectType, type AuthenticatedAgentRuntime } from '@flux/contracts';
import { assistantChangeRows, lockAgentMcpPolicy, sketchRows, type AssistantChangeRow, type DbExecutor } from '@flux/db';
import { classifyAssistantChange, DomainError, evaluateProject, loadActor, redactSecrets, type Database,
  type Transaction } from '@flux/core';
import { nativeConversationsInEventSession } from '../conversation/store.js';
import { nativeDocsInEventSession } from '../docs/adapters.js';
import { nativeMapRoomExists, prepareNativeMap } from '../editing/native-map-journal.js';
import { nativeCapacityRefusal, nativeSketchInEventSession } from '../sketches/adapters.js';
import { nativeWorkInEventSession } from '../work/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';
import type { ActionInput, NativeActions, Produced } from './action-execution.js';
import { agentConnectionInTransaction, type FluxMcpClaims } from './context.js';
import { createAgentConnectionStore } from './store.js';

// The assistant's effect path (F-027 AST-5/AST-6, A3 #403). An assistant run's change tool reaches the same
// native commands as a standing-grant client, but its authority is the run itself (`owner_request`): the run
// is live, the change fits the switches, the mode, the run's limit and the owner's rights ∩ the assistant's
// project grant. Each call is classified as applied, waiting, suggestion or refused and recorded in the
// change log in the same transaction. A waiting change keeps its exact prepared tool call; the owner's Apply
// (`owner_approval`) or the end of a live Wiki session (`owner_deferred_change`) re-executes exactly that
// call through this executor, with every check repeated and the target's version compared. Neither revives
// the run's token or calls a model.

/** The prepared tool call a waiting change keeps: its tool and its run-private arguments, redacted. */
export interface AssistantCall { tool: string; args: Record<string, unknown> }
/** What the run's tool returns instead of an object when its change waits or is deferred: plain words. */
export interface AssistantText { assistantText: string }
export const isAssistantText = (value: unknown): value is AssistantText =>
  !!value && typeof value === 'object' && typeof (value as AssistantText).assistantText === 'string';

/** A server-owned purpose that re-executes one saved change (never a client claim). */
export interface AssistantApproval { changeId: string; runId: string; purpose: 'owner_approval' | 'owner_deferred_change'; decidedBy: string | null }

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

const invalidated = (message: string) => new DomainError(403, 'ASSISTANT_CHANGE_INVALIDATED', message);
export const SKIPPED = 'ASSISTANT_CHANGE_SKIPPED';
const isVersionConflict = (error: unknown) => error instanceof DomainError && error.status === 409
  && /VERSION_CONFLICT|STALE|CHANGED/.test(error.code) && error.code !== 'IDEMPOTENCY_CONFLICT';

const OBJECT: Record<string, AssistantObjectType> = {
  'work.create': 'work', 'work.update': 'work', 'result.record': 'result', 'decision.propose': 'decision', 'doc.create': 'doc',
  'doc.update': 'doc', 'map.create': 'map', 'map.rename': 'map', 'map.thought.create': 'thought', 'map.thought.update': 'thought',
  'map.thought.delete': 'thought', 'map.positions.update': 'thought', 'map.link.create': 'link', 'map.link.delete': 'link',
  'conversation.create': 'message', 'conversation.reply': 'message',
};

interface Target {
  objectType: AssistantObjectType; objectId: string | null; title: string; mine: boolean; removal: boolean;
  /** The other person who made it (a person only), for "Jonas's task" and as a suggestion's recipient. */
  maker: string | null;
  beforeVersion: number | null; typist: { id: string; name: string } | null;
  words: ReturnType<typeof assistantChangeWords>;
}

/** Who made the target and how the change reads, read inside the change's transaction. */
async function describe(tx: Transaction, operation: string, objectId: string | null, payload: Record<string, unknown>,
  owner: string, agentId: string): Promise<Target> {
  const rows = assistantChangeRows(tx as DbExecutor);
  const ours = (maker: { userId: string | null; agentId: string | null } | null) => !!maker && (maker.userId === owner || maker.agentId === agentId);
  const otherPerson = (maker: { userId: string | null; agentId: string | null } | null) => maker?.userId && maker.userId !== owner ? maker.userId : null;
  const base = { objectType: OBJECT[operation] ?? 'work', objectId, title: '', mine: true, removal: false, maker: null, beforeVersion: null, typist: null,
    words: assistantChangeWords(operation) } satisfies Target;
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : '';
  switch (operation) {
    case 'work.create': case 'doc.create': case 'map.create': case 'decision.propose':
      return { ...base, objectId: null, title: text(payload.title) };
    case 'result.record': {
      const finishes = payload.finishes as { id?: string } | undefined;
      const work = finishes?.id ? await rows.work(finishes.id) : null;
      if (!work) return { ...base, objectId: null, title: text(payload.title) };
      const maker = { userId: work.ownerUserId ?? (work.createdByKind === 'human' ? work.createdById : null),
        agentId: work.ownerAgentId ?? (work.createdByKind === 'agent' ? work.createdById : null) };
      return { ...base, objectId: null, title: text(payload.title), mine: ours(maker), maker: otherPerson(maker) };
    }
    case 'work.update': {
      const work = objectId ? await rows.work(objectId) : null;
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const words = assistantChangeWords(operation, { status: changes.status as string | undefined, titleOnly: Object.keys(changes).length === 1 && 'title' in changes });
      if (!work) return { ...base, words, mine: false };
      // A task is yours when you or your assistant own it, or, with no owner, made it.
      const maker = work.ownerUserId || work.ownerAgentId ? { userId: work.ownerUserId, agentId: work.ownerAgentId }
        : { userId: work.createdByKind === 'human' ? work.createdById : null, agentId: work.createdByKind === 'agent' ? work.createdById : null };
      return { ...base, words, title: `#${work.number} ${work.title}`.slice(0, 200), mine: ours(maker), maker: otherPerson(maker),
        beforeVersion: typeof payload.expectedVersion === 'number' ? payload.expectedVersion : work.version };
    }
    case 'doc.update': {
      const doc = objectId ? await rows.doc(objectId) : null;
      if (!doc) return { ...base, mine: false };
      return { ...base, title: doc.title, mine: ours(doc), maker: otherPerson(doc), typist: await rows.liveTypist(doc.id, owner),
        beforeVersion: typeof payload.expectedVersion === 'number' ? payload.expectedVersion : doc.version };
    }
    case 'map.rename': {
      const map = objectId ? await rows.map(objectId) : null;
      return { ...base, title: map?.title ?? '', mine: ours(map), maker: otherPerson(map), beforeVersion: map?.version ?? null };
    }
    case 'map.thought.create': case 'map.link.create': {
      const map = objectId ? await rows.map(objectId) : null;
      return { ...base, objectId: null, title: operation === 'map.thought.create' ? text(payload.text) : map?.title ?? '' };
    }
    case 'map.thought.update': case 'map.thought.delete': {
      const [thought] = await rows.thoughts([String(payload.thoughtId)]);
      return { ...base, objectId: thought?.id ?? null, title: thought?.text.slice(0, 200) ?? '', mine: ours(thought ?? null), maker: otherPerson(thought ?? null),
        removal: operation === 'map.thought.delete', beforeVersion: thought?.version ?? null };
    }
    case 'map.positions.update': {
      const moves = (payload.moves ?? []) as { id: string }[];
      const thoughts = await rows.thoughts(moves.map((move) => move.id));
      const others = thoughts.filter((thought) => !ours(thought));
      return { ...base, objectId: null, title: `${moves.length} thought${moves.length === 1 ? '' : 's'}`,
        mine: thoughts.length === moves.length && !others.length, maker: others.map(otherPerson).find(Boolean) ?? null };
    }
    case 'map.link.delete': {
      const link = await rows.link(String(payload.linkId));
      return { ...base, objectId: String(payload.linkId), mine: ours(link), maker: otherPerson(link), removal: true };
    }
    case 'conversation.create': case 'conversation.reply':
      return { ...base, objectId: null, title: text((payload as { body?: unknown }).body).slice(0, 80) };
    default:
      return { ...base, mine: false };
  }
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

interface Authority {
  runtime: AuthenticatedAgentRuntime; workspaceId: string; agentId: string; policyVersion: number;
  run: NonNullable<Awaited<ReturnType<ReturnType<typeof assistantChangeRows>['lockRun']>>>;
  settings: NonNullable<Awaited<ReturnType<ReturnType<typeof assistantChangeRows>['settings']>>>;
  ownerCanWrite: boolean;
}

/** The checks every assistant change repeats, live: the binding, S6 entry and project, the grant and the owner's rights. */
async function currentAuthority(tx: Transaction, claims: FluxMcpClaims, projectId: string, tool: string, run: Authority['run'] | null,
  approval: AssistantApproval | undefined, prepared: AssistantChangeRow | null): Promise<Authority> {
  const rows = assistantChangeRows(tx as DbExecutor);
  let agentId: string; let workspaceId: string;
  if (!approval) {
    // The run's own token: in flight, its place, the S6 entry admitted by the route's dispatch, the agent's write grant.
    const context = await agentConnectionInTransaction(tx, claims, 'flux.action.execute', projectId);
    agentId = context.principal.id; workspaceId = context.workspaceId;
  } else {
    const grant = await createAgentConnectionStore(tx).grantForRun(claims.ownerUserId, claims.connectionId);
    if (!grant || grant.connection.id !== claims.connectionId || grant.connection.computeSource !== 'owner_assistant'
      || !grant.connection.scopes.includes('flux.action.execute') || !grant.connection.selectedProjectIds.includes(projectId))
      throw invalidated('Your assistant no longer has this project');
    agentId = grant.connection.agentId; workspaceId = grant.connection.workspaceId;
    const actor = await loadActor({ kind: 'agent', id: agentId }, workspaceId, tx, { lock: true });
    if (!actor.active || actor.agent?.ownerUserId !== claims.ownerUserId) throw invalidated('Your assistant is no longer available');
    const checked = await evaluateProject({ kind: 'agent', id: agentId }, 'project.write', projectId, tx, { lock: true });
    if (!checked.allowed || checked.project?.workspaceId !== workspaceId) throw invalidated('Your assistant can no longer change this project');
  }
  const policy = await lockAgentMcpPolicy(tx, claims.connectionId);
  const entry = AGENT_MCP_ENTRIES.find((item) => item.kind === 'tool' && item.name === tool);
  if (!policy || !entry || !policy.selectedProjectIds.includes(projectId) || !policy.enabledEntryIds.includes(entry.id)
    || !entry.requiredCapabilities.every((id) => policy.enabledCapabilityIds.includes(id))) throw invalidated('This switch is off now');
  // Turning a switch off, narrowing projects or re-enabling after a revoke invalidates saved intent: it is never resurrected.
  if (prepared && policy.version !== prepared.policyVersion) throw invalidated('Your assistant\'s switches changed since. Ask again');
  if (!run || run.ownerUserId !== claims.ownerUserId || run.projectId !== projectId || run.agentId !== agentId) throw invalidated('This request is unavailable');
  if (approval) {
    // A normally completed or still live source supplies provenance; a stopped, cancelled or failed one supplies nothing.
    if (run.stopRequestedAt || !['reading', 'dispatching', 'completed', 'truncated'].includes(run.status)) throw invalidated('This request was stopped. Ask again');
  }
  const settings = await rows.settings(claims.ownerUserId, workspaceId);
  if (!settings || settings.connectionId !== claims.connectionId || settings.agentId !== agentId) throw invalidated('Your assistant is no longer available');
  const enablement = await rows.enablement(claims.ownerUserId);
  if (!enablement) throw invalidated('Your assistant is off');
  if (approval && enablement.status !== 'active') throw new DomainError(409, 'ASSISTANT_PAUSED', 'Your assistant is paused. Resume it, then apply again');
  if (prepared && enablement.createdAt > prepared.createdAt) throw invalidated('Your assistant was turned off since. Ask again');
  const ownerCanWrite = (await evaluateProject({ kind: 'human', id: claims.ownerUserId }, 'project.write', projectId, tx, { lock: true })).allowed;
  const now = new Date();
  const runtime: AuthenticatedAgentRuntime = Object.freeze({ id: run.id, workspaceId, connectionId: claims.connectionId, ownerUserId: claims.ownerUserId,
    agentId, clientId: 'flux-assistant', grantReferenceId: `flux-run:${run.id}`, bindingGeneration: 0, scopes: ['flux.context.read', 'flux.action.execute'] as AgentScope[],
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  return { runtime, workspaceId, agentId, policyVersion: policy.version, run, settings, ownerCanWrite };
}

/**
 * The executor of a run token's change tools and of a saved change's re-execution. Same call shape as the
 * standing-grant executor, so every tool's own native effect is reused unchanged.
 */
export function assistantChangeExecutor(db: Database, claims: FluxMcpClaims) {
  return async function execute<T extends { [key: string]: AgentJsonValue }>(input: ActionInput, operation: AgentOperation,
    objectId: string | null, payload: AgentJsonValue, effect: (native: NativeActions) => Promise<Produced<T>>): Promise<(T & { replayed: boolean }) | AssistantText> {
    const call = input.assistantCall;
    const approval = claims.approval;
    const runId = claims.run?.id ?? approval?.runId;
    if (!call || !runId) throw new DomainError(403, 'AGENT_EXECUTION_UNAVAILABLE', 'This change needs its assistant run');
    // Anything outside the run's place has no tool to reach it (AST-5 case 8).
    if (claims.run && input.projectId !== claims.run.projectId) throw new DomainError(403, 'OUTSIDE_RUN_PLACE', 'An assistant run changes only the project it was asked in');
    const fingerprint = assistantCallFingerprint(call);
    const live = operation.startsWith('map.') && objectId !== null && await nativeMapRoomExists(db as DbExecutor, objectId);
    const releases = new Set<() => void>();
    if (live) releases.add(await prepareNativeMap({ claims, command: { operation, objectId, payload } }).catch((error: unknown) => { throw nativeCapacityRefusal(error); }));
    let described: Target | null = null; let authority: Authority | null = null;
    try {
      return await db.transaction(async (tx) => {
        const rows = assistantChangeRows(tx as DbExecutor);
        const session = transactionEventSession(tx);
        // The run row first: concurrent calls of one run serialize here, so its change count is exact.
        const runRow = await rows.lockRun(runId);
        const prepared = approval ? await rows.lock(approval.changeId) : null;
        if (approval && (!prepared || prepared.state !== 'waiting' || prepared.fingerprint !== fingerprint || prepared.runId !== runId
          || prepared.ownerUserId !== claims.ownerUserId))
          throw new DomainError(409, 'ASSISTANT_CHANGE_UNAVAILABLE', 'This change is no longer waiting');
        if (!approval) {
          const stored = await rows.byCommand(runId, input.clientCommandId);
          if (stored) {
            if (stored.fingerprint !== fingerprint) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This command ID belongs to another change');
            if (stored.state === 'applied' && stored.receipt) return { ...(stored.receipt.value as T), replayed: true };
            return { assistantText: stored.refusal ?? 'This change is waiting for your OK' };
          }
        }
        authority = await currentAuthority(tx, claims, input.projectId, call.tool, runRow, approval, prepared);
        const ownerName = (await rows.names([claims.ownerUserId])).get(claims.ownerUserId) ?? 'your owner';
        described = await describe(tx, operation, objectId, (payload ?? {}) as Record<string, unknown>, claims.ownerUserId, authority.agentId);
        const target = described;
        const phrase = `${target.words.phrase} ${target.words.noun}`;
        if (!approval) {
          const outcome = classifyAssistantChange({ mode: authority.settings.approvalMode, ownerCanWrite: authority.ownerCanWrite, removal: target.removal,
            mine: target.mine, liveTypist: !!target.typist && operation === 'doc.update', reserved: await rows.reserved(runId), limit: authority.settings.changesPerRun });
          if (outcome.state === 'waiting') {
            const createdAt = new Date();
            if (Buffer.byteLength(JSON.stringify(call), 'utf8') > ASSISTANT_CHANGE_LIMITS.preparedBytes)
              throw new DomainError(413, 'ASSISTANT_CHANGE_TOO_LARGE', 'This change is too large to keep for your OK');
            await rows.insert({ id: randomUUID(), workspaceId: authority.workspaceId, projectId: input.projectId, runId, ownerUserId: claims.ownerUserId,
              agentId: authority.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
              objectId: target.objectId, objectTitle: target.title, state: 'waiting', waitReason: outcome.reason, preparedCommand: call,
              policyVersion: authority.policyVersion, beforeVersion: target.beforeVersion, otherUserId: outcome.reason === 'live_wiki' ? target.typist!.id : target.maker,
              suggestToUserId: outcome.reason === 'outside_rights' ? target.maker : null,
              createdAt, expiresAt: new Date(createdAt.getTime() + ASSISTANT_CHANGE_LIMITS.expiryDays * 86_400_000) });
            await session.flushEvents();
            const text = outcome.reason === 'live_wiki' ? `I'll edit ${target.title} when ${target.typist!.name} finishes typing.`
              : outcome.reason === 'outside_rights' ? `Prepared as a suggestion: ${phrase}. ${ownerName} decides whether to send it.`
              : `Waiting for ${ownerName}'s OK: ${phrase}${target.title ? ` ${target.title}` : ''}.`;
            return { assistantText: text };
          }
        } else if (approval.purpose === 'owner_deferred_change' && authority.settings.approvalMode !== 'act') {
          throw new DomainError(409, 'ASSISTANT_NOW_ASKS', 'Your assistant now asks first');
        } else if (approval.purpose === 'owner_approval' && !authority.ownerCanWrite) {
          throw invalidated('You can no longer change this. Ask again');
        }
        const produced = await effect(natives(tx, session, authority.runtime, live, input.clientCommandId, operation, fingerprint, releases));
        const receipt = { value: produced.value, postconditions: produced.postconditions, authority: approval?.purpose ?? 'owner_request', runId,
          engine: authority.run.engine, ownerUserId: claims.ownerUserId, agentId: authority.agentId, preparedBy: authority.agentId,
          ...(approval?.decidedBy ? { approvedBy: approval.decidedBy } : {}) } as unknown as Record<string, unknown>;
        const after = afterVersion(produced.postconditions);
        const createdId = producedId(produced.value as Record<string, unknown>);
        if (prepared) {
          await rows.update(prepared.id, { state: 'applied_after_wait', waitReason: null, authority: approval!.purpose, receipt, afterVersion: after,
            objectId: prepared.objectId ?? createdId, ...(approval!.decidedBy ? { decidedBy: approval!.decidedBy, decidedAt: new Date() } : {}) });
        } else {
          const createdAt = new Date();
          await rows.insert({ id: randomUUID(), workspaceId: authority.workspaceId, projectId: input.projectId, runId, ownerUserId: claims.ownerUserId,
            agentId: authority.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
            objectId: target.objectId ?? createdId, objectTitle: target.title, state: 'applied', authority: 'owner_request', preparedCommand: call, policyVersion: authority.policyVersion,
            beforeVersion: target.beforeVersion, afterVersion: after, receipt, createdAt,
            expiresAt: new Date(createdAt.getTime() + ASSISTANT_CHANGE_LIMITS.expiryDays * 86_400_000) });
        }
        await session.flushEvents();
        return { ...(produced.value as T), replayed: false };
      });
    } catch (error) {
      // A person changed the object between the run's read and its write: skipped, never retried (AST-6.7).
      if (!approval && isVersionConflict(error) && described && authority) {
        const target = described as Target; const held = authority as Authority;
        const who = target.objectId ? await assistantChangeRows(db as DbExecutor).lastActor(target.objectId) : null;
        const label = target.objectType === 'work' ? target.title.split(' ')[0] : target.title;
        const refusal = `Skipped ${label}: ${who?.name ?? 'someone'} changed it while I worked`.slice(0, 500);
        await db.transaction(async (tx) => {
          const rows = assistantChangeRows(tx as DbExecutor);
          if (await rows.byCommand(runId, input.clientCommandId)) return;
          const createdAt = new Date();
          await rows.insert({ id: randomUUID(), workspaceId: held.workspaceId, projectId: input.projectId, runId, ownerUserId: claims.ownerUserId,
            agentId: held.agentId, clientCommandId: input.clientCommandId, fingerprint, tool: call.tool, operation, objectType: target.objectType,
            objectId: target.objectId, objectTitle: target.title, state: 'refused', refusal, preparedCommand: call, otherUserId: null, policyVersion: held.policyVersion, beforeVersion: target.beforeVersion,
            createdAt, expiresAt: new Date(createdAt.getTime() + ASSISTANT_CHANGE_LIMITS.expiryDays * 86_400_000) });
        });
        throw new DomainError(409, SKIPPED, refusal);
      }
      throw error;
    } finally { for (const release of releases) release(); }
  };
}
