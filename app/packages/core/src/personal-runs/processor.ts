import { randomUUID } from 'node:crypto';
import { PERSONAL_RUN_LIMITS, personalRunMaxInputTokens, type AiPrice } from '@flux/contracts';
import { boundedInputTokens, conservativeTokenEstimate } from '../ai/estimate.js';
import { ForbiddenError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { JobRetryPolicy } from '../push/config.js';
import { isId } from '../work/validation.js';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup,
  PersonalRunPorts, PersonalRunTokenIssuer, PersonalRunUnitOfWork, PersonalRuntime, PersonalToolHost, PersonalToolSession, RunChanges, RunRecord,
} from './ports.js';
import { redactSecrets } from './redaction.js';
import { createRuntimeRunProcessor, type RuntimeCaps } from './runtime-run.js';
import { updateAndAnnounce } from './progress.js';
import { requestParts, runToolLoop, type LoopResult, type RunAccount } from './tool-loop.js';
import {
  centsToMicros, connectionCallsTools, parseOutput, requestInput, runChargeMicros, runTokensWithinLimits, SYSTEM_PROMPT, TOOL_SYSTEM_PROMPT, type SuppliedSource,
} from './validation.js';

// The worker side of a personal run (`personal-run.dispatch.v1`, O-008 §3–§5). The job payload
// is the run id only. Before reading, before dispatch and inside the commit transaction the run
// is checked again: the owner's enablement (pause, removal), the owner's own connection, the
// agent (`agent.invoke`), the agent's and owner's current project access, and before dispatch
// the daily cap. A run refused before dispatch costs zero and releases its reservation. After
// dispatch the observed usage is charged, but a refusal at commit stores nothing: the answer is
// withheld and no proposal is created. There is never another payer or connection to fall back to.
//
// A run with tools (F-027 AST-8, `tools` below and `tool-loop.ts`) is a bounded loop of such
// requests: the same rechecks run before every further request, each request is reconciled by
// itself against the run's reservation, and a run that reaches its turn cap, its money
// reservation or one request's input bound ends `cap_reached` ("Limit reached") with the changes
// it already made kept. A run without tools, or on a model that cannot call them, is one request.

export const PERSONAL_RUN_JOB = 'personal-run.dispatch.v1';

/** Never retried by the queue (O-008 §4): a failed dispatch ends the run; the owner retries as a new run. */
export const PERSONAL_RUN_QUEUE: Pick<JobRetryPolicy, 'retryLimit' | 'expireInSeconds' | 'deleteAfterSeconds'> = {
  retryLimit: 0,
  expireInSeconds: 300,
  deleteAfterSeconds: 7 * 24 * 3600,
};

export type PersonalRunOutcome = RunRecord['status'] | 'skipped';

/** Test seams around the three rechecks. */
export interface PersonalRunHooks {
  /** After the sources were read, before the dispatch recheck. */
  afterRead?: (run: RunRecord) => Promise<void>;
  /** After the provider answered, before the commit transaction. */
  afterDispatch?: (run: RunRecord) => Promise<void>;
}

export interface PersonalRunProcessorDeps {
  uow: PersonalRunUnitOfWork;
  connections: PersonalConnectionLookup;
  compute: PersonalCompute;
  /** How often a dispatching run checks for the owner's stop. */
  stopPollMs?: number;
  hooks?: PersonalRunHooks;
  /**
   * Opens the tools of a run (F-027 AST-8): the worker's MCP client with the run token. Without
   * it every run is one request with no tools, as before.
   */
  tools?: PersonalToolHost;
  /** The most requests of one run with tools; at most {@link PERSONAL_RUN_LIMITS}`.maxTurns`. */
  maxTurns?: number;
  /** The clock bound of a run with tools (AST-6: five minutes). */
  wallClockMs?: number;
  now?: () => number;
  /**
   * The owner's own Claude Code in the agent runtime (F-022 AIM-3, #280) and the run token's minting
   * (F-027 A2). Without them a `runtime` run ends `unavailable` at zero cost.
   */
  runtime?: PersonalRuntime;
  tokens?: PersonalRunTokenIssuer;
  /** Test seam: lower runtime run caps (within the protocol's bounds); production uses RUNTIME_RUN_LIMITS. */
  runtimeCaps?: Partial<RuntimeCaps>;
}

type Stage = 'before_read' | 'before_dispatch' | 'before_commit';
type Refusal = Extract<RunRecord['status'], 'denied' | 'paused' | 'revoked' | 'unavailable' | 'cap_reached'>;

const MESSAGE_WINDOW = 40;
const WORK_WINDOW = 20;

function isAccessDenial(error: unknown) {
  return error instanceof NotFoundError || error instanceof ForbiddenError;
}

/**
 * The owner's standing at one step. Null when the run may continue; otherwise the terminal
 * status. `lock` holds the rows the decision depends on until the unit of work commits.
 */
async function recheck(ports: PersonalRunPorts, connections: PersonalConnectionLookup, compute: PersonalCompute, run: RunRecord, stage: Stage, lock: boolean): Promise<{ refusal: Refusal } | { connection: PersonalConnection }> {
  const enablement = await ports.runs.enablement(run.ownerUserId, { lock });
  if (!enablement || enablement.agents.find((agent) => agent.workspaceId === run.workspaceId)?.agentId !== run.agentId) return { refusal: 'revoked' };
  if (enablement.status === 'paused') return { refusal: 'paused' };
  const owner: Principal = { kind: 'human', id: run.ownerUserId };
  const agent: Principal = { kind: 'agent', id: run.agentId };
  if (!(await ports.access.canInvoke(owner, run.agentId, { lock }))) return { refusal: 'revoked' };
  // A run that holds a run token acts as the owner's assistant connection (F-027 AST-3): revoking it ends the run.
  if (run.runTokenJti && ports.runs.assistantConnectionLive && !(await ports.runs.assistantConnectionLive(run.ownerUserId, run.workspaceId)))
    return { refusal: 'revoked' };
  if (!compute.enabled) return { refusal: 'unavailable' };
  // Exactly the connection the run was started on (PROV-1), never the owner's newest or another.
  const connection = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== run.ownerUserId
    || connection.id !== run.connectionId || connection.id !== enablement.connectionId) return { refusal: 'unavailable' };
  // The sources are the intersection of the owner's rights and the agent grant in this project;
  // the answer is posted to the place, so its owner must still be able to write there.
  if (!(await ports.access.canUseProject(owner, 'write', run.projectId, { lock })) || !(await ports.access.canUseProject(agent, 'read', run.projectId, { lock })))
    return { refusal: 'denied' };
  if (stage === 'before_dispatch') {
    const spend = await ports.runs.spendToday(run.ownerUserId, enablement.timeZone, run.id);
    if (spend.chargedMicros + spend.reservedMicros + run.reservedMicros > centsToMicros(enablement.dailyCapCents)) return { refusal: 'cap_reached' };
  }
  return { connection };
}

const ended = (status: RunRecord['status'], stage: Stage | null, extra: RunChanges = {}): RunChanges => ({
  status, stoppedAtStage: stage, completedAt: new Date(), ...extra,
});
const free: RunChanges = { costState: 'released', chargedMicros: 0 };

/** Reads the project-audience sources of the run as its agent. Private places are never read. */
async function readSources(ports: PersonalRunPorts, run: RunRecord): Promise<{ sources: SuppliedSource[]; earlier: string | null } | null> {
  const agent: Principal = { kind: 'agent', id: run.agentId };
  await ports.access.requireProject(agent, 'read', run.projectId);
  const sources: SuppliedSource[] = [];
  const next = () => `S${sources.length + 1}`;
  // The owner's switches (F-027 AST-4): an Off area is never assembled as ambient context. The owner's
  // request itself is input, not permission to read its conversation (AST-4, #401 C2).
  const areas = ports.runs.assistantAreas ? await ports.runs.assistantAreas(run.ownerUserId, run.workspaceId) : null;
  const on = (area: 'tasks' | 'maps' | 'conversations') => !areas || areas[area] !== 'off';
  if (run.targetSketchId && run.targetThoughtId && on('maps')) {
    // Agents never see private sketches; the thought must be on a project sketch of this project.
    if (!(await ports.access.canReadSketch(agent, run.targetSketchId))) return null;
    const thought = await ports.runs.thought(run.targetSketchId, run.targetThoughtId);
    if (!thought || thought.sketchScope !== 'project' || thought.sketchProjectId !== run.projectId) return null;
    sources.push({ label: next(), ref: { type: 'thought', id: thought.id, sketchId: thought.sketchId, revision: thought.version }, text: `Selected map thought: ${thought.text}` });
  }
  for (const message of on('conversations') ? await ports.runs.messages(run.conversationId, MESSAGE_WINDOW) : [])
    sources.push({ label: next(), ref: { type: 'message', id: message.id, revision: 1 }, text: `Message ${message.sequence}${message.contribution ? ` (${message.contribution.kind}${message.contribution.kind === 'result' ? `; result ${message.contribution.resultId}` : ''})` : ''} by ${message.authorName}${message.author.kind === 'agent' ? ' (agent)' : ''}: ${message.body}${message.files?.length ? `\nAttached files (contents not included): ${message.files.map((file) => `${file.name} (${file.size} bytes; file ${file.id})`).join(', ')}` : ''}` });
  for (const work of on('tasks') ? await ports.runs.openWork(run.projectId, WORK_WINDOW) : [])
    sources.push({ label: next(), ref: { type: 'work', id: work.id, revision: work.version }, text: `Open work item "${work.title}" (${work.status})${work.outcome ? `: ${work.outcome}` : ''}` });
  let earlier: string | null = null;
  if (run.continuesRunId && on('conversations')) {
    const previous = await ports.runs.findRun(run.continuesRunId);
    if (previous?.ownerUserId === run.ownerUserId && previous.conversationId === run.conversationId) earlier = previous.answerBody;
  }
  return { sources, earlier };
}

/**
 * Drops the oldest conversation messages until the input fits the limit. Every provider is bounded
 * by the same conservative Flux estimate (F-020 PROV-3); a provider with a token-count endpoint may
 * raise that estimate, never lower it. A count sends the input to the provider, so `beforeCount`
 * rechecks the run's standing before every count request and ends the fit with its outcome when the
 * run may no longer send anything. A run with tools has the larger bound (#484).
 */
async function fit(compute: PersonalCompute, base: Omit<PersonalComputeRequest, 'input'>, run: RunRecord,
  read: { sources: SuppliedSource[]; earlier: string | null }, beforeCount: () => Promise<PersonalRunOutcome | null>, maxInputTokens: number) {
  let sources = read.sources;
  for (;;) {
    const request = { ...base, input: requestInput(run, sources, read.earlier) };
    let tokens = conservativeTokenEstimate(requestParts(request));
    if (tokens <= maxInputTokens && compute.countInputTokens) {
      const refused = await beforeCount();
      if (refused) return { refused: true as const, outcome: refused };
      tokens = boundedInputTokens(tokens, await compute.countInputTokens(request));
    }
    if (tokens <= maxInputTokens) return { refused: false as const, request, sources };
    const oldest = sources.findIndex((source) => source.ref.type === 'message');
    if (oldest === -1) return null;
    sources = sources.filter((_, index) => index !== oldest);
  }
}

/**
 * The production provider until the operator switch and a real connection lookup exist (see
 * docs/development/personal-runs.md): switched off, so every queued run ends `unavailable` at zero cost.
 */
export const unavailablePersonalCompute: PersonalCompute = {
  enabled: false,
  dispatch: async () => ({ kind: 'failed', reason: 'provider_error', billed: 'none' }),
};

/** AST-6: a run with tools has five minutes. */
const WALL_CLOCK_MS = 5 * 60_000;

export function createPersonalRunProcessor({ uow, connections, compute, stopPollMs = 250, hooks = {}, tools, maxTurns = PERSONAL_RUN_LIMITS.maxTurns,
  wallClockMs = WALL_CLOCK_MS, now = Date.now, runtime, tokens, runtimeCaps }: PersonalRunProcessorDeps) {
  const runtimeRuns = createRuntimeRunProcessor({ uow, runtime, tokens, stopPollMs, hooks, ...(runtimeCaps ? { caps: runtimeCaps } : {}) });
  /** Aborts the provider request as soon as the owner's stop is recorded. */
  function watchStop(runId: string, controller: AbortController) {
    let active = true;
    const loop = async () => {
      while (active && !controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, stopPollMs));
        if (!active) return;
        try {
          const run = await uow.run((ports) => ports.runs.findRun(runId));
          if (run?.stopRequestedAt) controller.abort();
        } catch {
          // A failed poll only delays the best-effort abort; the commit recheck still sees the stop.
        }
      }
    };
    void loop();
    return () => { active = false; };
  }

  /**
   * What the run is charged, from one request (the single-request run) or from the sum of its
   * reconciled requests (a run with tools). `withhold`: a request's usage was outside its bounds, so
   * its cost is unknown and nothing is posted.
   */
  type Settlement = { charge: RunChanges; withhold: boolean };

  /** The usage is charged at the price of the connection the run was reserved on, or as the provider reported it (PROV-3), never above the run's reservation. */
  function settleRequest(run: RunRecord, result: PersonalComputeResult, price: AiPrice | null): Settlement {
    // Usage beyond the run's token limits, or a cost above its reservation, is treated as a lost
    // response: the cost is unknown, the whole reservation stays counted against the daily cap, the
    // reported numbers are not stored, and the answer is withheld. Without a price the charge stays unknown too.
    const usage = result.kind === 'completed' ? result.usage : null;
    const tokens: RunChanges = usage && runTokensWithinLimits(usage) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {};
    const chargedMicros = usage && price ? runChargeMicros(usage, price, run.reservedMicros) : null;
    const outOfBounds = usage !== null && price !== null && chargedMicros === null;
    const charge: RunChanges = chargedMicros !== null ? { costState: 'observed', chargedMicros, ...tokens }
      : result.kind === 'completed' && !outOfBounds ? { costState: 'unknown', chargedMicros: 0, ...tokens }
        : result.kind === 'failed' && result.billed === 'none' ? { ...free } : { costState: 'unknown', chargedMicros: 0 };
    return { charge, withhold: outOfBounds };
  }

  /**
   * The same for a run with tools: every request was reconciled when it came back, so the account
   * is the charge. A request that may have been billed without a usable report keeps the whole
   * reservation counted as `unknown`.
   */
  function settleAccount(account: RunAccount): Settlement {
    if (account.unknown) return { charge: { costState: 'unknown', chargedMicros: 0 }, withhold: true };
    if (account.requests === 0) return { charge: { ...free }, withhold: false };
    return { charge: { costState: 'observed', chargedMicros: account.micros, inputTokens: account.inputTokens, outputTokens: account.outputTokens }, withhold: false };
  }

  /** How a run that did not end in an answer is closed: at one of its own limits, or at a standing check. */
  type Early = { status: RunRecord['status']; stage: Stage };

  async function commit(runId: string, result: PersonalComputeResult | null, sources: SuppliedSource[],
    settle: (run: RunRecord) => Settlement, early: Early | null = null): Promise<PersonalRunOutcome> {
    return uow.run(async (ports) => {
      const located = await ports.runs.findRun(runId);
      if (!located || located.status !== 'dispatching') return 'skipped';
      const initial = await recheck(ports, connections, compute, located, 'before_commit', true).catch((error: unknown) => { if (isAccessDenial(error)) return { refusal: 'denied' as const }; throw error; });
      const preview = result?.kind === 'completed' ? parseOutput(redactSecrets(result.text).text, sources, result.stopReason !== 'max_tokens') : null;
      const refs = [...sources.map((source) => source.ref), ...(preview?.proposal?.finishesWorkId ? [{ type: 'work', id: preview.proposal.finishesWorkId }] : [])];
      const taskFence = !('refusal' in initial) && preview
        ? await ports.runs.prepareTaskUse(located.projectId, located.conversationId, refs) : null;
      const run = await ports.runs.findRun(runId, { lock: true });
      if (!run || run.status !== 'dispatching') return 'skipped';
      const { charge, withhold } = settle(run);
      if (run.stopRequestedAt) return (await updateAndAnnounce(ports, run.id, ended('stopped', 'before_commit', charge))).status;
      // A tool result passed the MCP route's bound (F-022 "Caps"): the run ends in its own state, nothing is posted.
      if (run.mcpLimit) return (await updateAndAnnounce(ports, run.id, ended('cap_reached', 'before_commit', { ...charge, endReason: 'mcp_results_too_large' }))).status;
      if (early) return (await updateAndAnnounce(ports, run.id, ended(early.status, early.stage, charge))).status;
      // A `tool_use` stop here means a request without tools came back asking for some: its text is
      // half an answer to a call that will never be made, so nothing is posted (the cost stays as observed).
      if (!result || result.kind === 'failed' || withhold || result.stopReason === 'tool_use') return (await updateAndAnnounce(ports, run.id, ended('provider_failed', null, charge))).status;
      let checked: Awaited<ReturnType<typeof recheck>>;
      try {
        checked = await recheck(ports, connections, compute, run, 'before_commit', true);
      } catch (error) {
        if (!isAccessDenial(error)) throw error;
        checked = { refusal: 'denied' };
      }
      // Access, grant, pause or connection changed after the read: the output is withheld.
      if ('refusal' in checked) return (await updateAndAnnounce(ports, run.id, ended(checked.refusal, 'before_commit', charge))).status;
      const truncated = result.stopReason === 'max_tokens';
      // The same redaction as a runtime answer's (F-022 AIM-3, F-027 AST-9, #484): token-shaped strings never reach the conversation.
      const redacted = redactSecrets(result.text);
      const parsed = parseOutput(redacted.text, sources, !truncated);
      const agent: Principal = { kind: 'agent', id: run.agentId };
      const committedAt = new Date();
      const updated = await updateAndAnnounce(ports, run.id, ended(truncated ? 'truncated' : 'completed', null, {
        ...charge, answerBody: parsed.body || (parsed.proposal ? 'Drafted a proposal.' : '(No answer text.)'),
        answerTruncated: truncated, answerSources: parsed.sources, answerRedacted: redacted.changed, committedAt,
      }));
      if (parsed.proposal) {
        const proposal = await ports.runs.insertProposal({
          id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId, runId: run.id, ownerUserId: run.ownerUserId,
          fact: parsed.proposal.fact, interpretation: parsed.proposal.interpretation, resultTitle: parsed.proposal.title,
          resultFinding: parsed.proposal.finding, resultEvidence: parsed.proposal.evidence, finishesWorkId: parsed.proposal.finishesWorkId,
        });
        await ports.events.record(agent, run.workspaceId, 'project.assistant_proposal_created.v1', run.projectId, { runId: run.id, proposalId: proposal.id });
      }
      await ports.events.record(agent, run.workspaceId, 'project.assistant_answer_committed.v1', run.projectId, { conversationId: run.conversationId, runId: run.id });
      await taskFence?.mark();
      return updated.status;
    });
  }

  /** The loop's end, as the run's commit: an answer is committed like a single request's; every other end closes the run. */
  function commitLoop(runId: string, loop: LoopResult, sources: SuppliedSource[]): Promise<PersonalRunOutcome> {
    const settle = () => settleAccount(loop.account);
    const { end } = loop;
    switch (end.kind) {
      case 'answer': return commit(runId, end.result, sources, settle);
      case 'failed': return commit(runId, end.result, sources, settle);
      case 'lost': return commit(runId, null, sources, settle);
      // The turn cap, the money reservation, the input bound or the clock: "Limit reached".
      case 'limit': return commit(runId, null, sources, settle, { status: 'cap_reached', stage: 'before_dispatch' });
      case 'halted': return end.status === 'gone' ? Promise.resolve('skipped') : commit(runId, null, sources, settle, { status: end.status, stage: 'before_dispatch' });
    }
  }

  /** Fits, rechecks and sends the run: one request, or the bounded loop when it has tools. */
  async function dispatchRun(run: RunRecord, read: { sources: SuppliedSource[]; earlier: string | null }, connection: PersonalConnection,
    session: PersonalToolSession | null, beforeSend: () => Promise<PersonalRunOutcome | null>): Promise<PersonalRunOutcome> {
    let fitted: Awaited<ReturnType<typeof fit>>;
    try {
      fitted = await fit(compute, {
        connection: { id: connection.id, keyRef: connection.keyRef, provider: connection.provider, baseUrl: connection.baseUrl }, model: run.model,
        maxTokens: PERSONAL_RUN_LIMITS.maxOutputTokens, effort: PERSONAL_RUN_LIMITS.effort,
        system: session ? TOOL_SYSTEM_PROMPT : SYSTEM_PROMPT, ...(session ? { tools: session.tools } : {}),
      }, run, read, beforeSend, personalRunMaxInputTokens(!!session));
    } catch {
      // The preflight count failed (provider down, key refused). Counting is free and nothing
      // was dispatched: the run ends at zero cost and the owner may retry it as a new run.
      return uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (current?.status !== 'reading') return (current?.status ?? 'skipped') as PersonalRunOutcome;
        return (await updateAndAnnounce(ports, run.id, ended('provider_failed', 'before_dispatch', free))).status;
      });
    }
    if (fitted?.refused) return fitted.outcome;

    const ready = await uow.run(async (ports) => {
      const located = await ports.runs.findRun(run.id);
      if (!located || located.status !== 'reading') return { done: true as const, outcome: 'skipped' as PersonalRunOutcome };
      const preliminary = await recheck(ports, connections, compute, located, 'before_dispatch', true).catch((error: unknown) => { if (isAccessDenial(error)) return { refusal: 'denied' as const }; throw error; });
      // Current authority is retained before graphs/tasks and the run/domain row.
      const taskFence = !('refusal' in preliminary) && fitted && !fitted.refused
        ? await ports.runs.prepareTaskUse(located.projectId, located.conversationId, fitted.sources.map((source) => source.ref)) : null;
      const current = await ports.runs.findRun(run.id, { lock: true });
      const end = async (status: RunRecord['status']) => ({ done: true as const, outcome: (await updateAndAnnounce(ports, run.id, ended(status, 'before_dispatch', free))).status as PersonalRunOutcome });
      if (!current || current.status !== 'reading') return { done: true as const, outcome: 'skipped' as PersonalRunOutcome };
      if (current.stopRequestedAt) return end('stopped');
      const checked = await recheck(ports, connections, compute, current, 'before_dispatch', true).catch((error: unknown) => {
        if (isAccessDenial(error)) return { refusal: 'denied' as const };
        throw error;
      });
      if ('refusal' in checked) return end(checked.refusal);
      if (checked.connection.id !== connection.id) return end('unavailable');
      if (!fitted) return end('input_too_large');
      await updateAndAnnounce(ports, run.id, { status: 'dispatching', dispatchedAt: new Date(), answerSources: fitted.sources.map((source) => source.ref) });
      await taskFence?.mark();
      return { done: false as const, fitted };
    });
    if (ready.done) return ready.outcome;

    const controller = new AbortController();
    const stopWatching = watchStop(run.id, controller);
    if (session) {
      // A standing check between the turns of the loop: the same as before a dispatch. It also
      // touches the row, so a long loop is not swept as a crashed worker's.
      const gate = (): Promise<{ status: RunRecord['status'] | 'gone' } | null> => uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'dispatching') return { status: 'gone' as const };
        if (current.stopRequestedAt) return { status: 'stopped' as const };
        if (current.mcpLimit) return { status: 'cap_reached' as const };
        const checked = await recheck(ports, connections, compute, current, 'before_dispatch', true).catch((error: unknown) => {
          if (isAccessDenial(error)) return { refusal: 'denied' as const };
          throw error;
        });
        if ('refusal' in checked) return { status: checked.refusal };
        if (checked.connection.id !== connection.id) return { status: 'unavailable' as const };
        await ports.runs.updateRun(run.id, {});
        return null;
      });
      let loop: LoopResult;
      try {
        loop = await runToolLoop({
          compute, session, first: ready.fitted.request, price: connection.price!, reservedMicros: run.reservedMicros,
          maxTurns: Math.max(1, Math.min(maxTurns, PERSONAL_RUN_LIMITS.maxTurns)), deadline: now() + wallClockMs, now, gate, signal: controller.signal,
        });
      } catch {
        // An unexpected failure inside the loop is a lost response: the reservation stays counted.
        loop = { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'unknown' } }, account: { micros: 0, inputTokens: 0, outputTokens: 0, requests: 0, unknown: true }, turns: 0 };
      } finally {
        stopWatching();
      }
      await hooks.afterDispatch?.(run);
      return commitLoop(run.id, loop, ready.fitted.sources);
    }
    let result: PersonalComputeResult;
    try {
      result = await compute.dispatch(ready.fitted.request, controller.signal);
    } catch {
      // An unexpected adapter failure is a lost response: the reservation stays counted.
      result = { kind: 'failed', reason: 'provider_error', billed: 'unknown' };
    } finally {
      stopWatching();
    }
    await hooks.afterDispatch?.(run);
    return commit(run.id, result, ready.fitted.sources, (current) => settleRequest(current, result, connection.price));
  }

  return {
    /** One dispatch job. Returns the run's final status, or `skipped` for a run that is not queued. */
    async process(runId: unknown): Promise<PersonalRunOutcome> {
      if (!isId(runId)) return 'skipped';
      const id = runId.toLowerCase();
      // A run on the owner's own Claude Code goes to the agent runtime (F-022 AIM-3 "Run", #280).
      const engine = (await uow.run((ports) => ports.runs.findRun(id)))?.engine;
      if (engine === 'runtime') return runtimeRuns.process(id);
      const claimed = await uow.run(async (ports) => {
        const run = await ports.runs.findRun(id, { lock: true });
        if (!run || run.status !== 'queued') return null;
        const checked = await recheck(ports, connections, compute, run, 'before_read', true).catch((error: unknown) => {
          if (isAccessDenial(error)) return { refusal: 'denied' as const };
          throw error;
        });
        if ('refusal' in checked) return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended(checked.refusal, 'before_read', free))).status };
        return { done: false as const, run: await updateAndAnnounce(ports, run.id, { status: 'reading' }) };
      });
      if (!claimed) return 'skipped';
      if (claimed.done) return claimed.status;
      const run = claimed.run;

      const read = await uow.run((ports) => readSources(ports, run)).catch((error: unknown) => {
        if (isAccessDenial(error)) return null;
        throw error;
      });
      if (!read) {
        return uow.run(async (ports) => {
          const current = await ports.runs.findRun(run.id, { lock: true });
          if (current?.status !== 'reading') return 'skipped' as const;
          return (await updateAndAnnounce(ports, run.id, ended('denied', 'before_read', free))).status;
        });
      }
      await hooks.afterRead?.(run);

      // Preflight counting is a provider call that sends the input: it runs outside any
      // transaction, on the owner's own connection, and only after the same recheck as a dispatch
      // (stop, enablement, agent, owner and agent access, cap, connection) before every request.
      const connection = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
      const beforeSend = (): Promise<PersonalRunOutcome | null> => uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'reading') return current?.status ?? 'skipped';
        const end = async (status: RunRecord['status']) => (await updateAndAnnounce(ports, run.id, ended(status, 'before_dispatch', free))).status;
        if (current.stopRequestedAt) return end('stopped');
        const checked = await recheck(ports, connections, compute, current, 'before_dispatch', true).catch((error: unknown) => {
          if (isAccessDenial(error)) return { refusal: 'denied' as const };
          throw error;
        });
        if ('refusal' in checked) return end(checked.refusal);
        if (!connection || checked.connection.id !== connection.id) return end('unavailable');
        return null;
      });
      if (!connection) {
        const refused = await beforeSend();
        return refused ?? 'skipped';
      }
      // The run's tools (F-027 AST-8), only on a connection that can call them and has a known price
      // to reserve and reconcile against. No host, no tools, or a model marked without tool calling:
      // one request with no tools, as before.
      let session: PersonalToolSession | null = null;
      if (tools && connection.price && connectionCallsTools(connection)) {
        try {
          session = await tools(run, connection);
        } catch {
          // The run was started with tools it cannot have now (no run token): it does not quietly become another run.
          return uow.run(async (ports) => {
            const current = await ports.runs.findRun(run.id, { lock: true });
            if (current?.status !== 'reading') return (current?.status ?? 'skipped') as PersonalRunOutcome;
            return (await updateAndAnnounce(ports, run.id, ended('unavailable', 'before_dispatch', free))).status;
          });
        }
        if (session && !session.tools.length) {
          await session.close().catch(() => undefined);
          session = null;
        }
      }
      try {
        return await dispatchRun(run, read, connection, session, beforeSend);
      } finally {
        await session?.close().catch(() => undefined);
      }
    },
  };
}

export type PersonalRunProcessor = ReturnType<typeof createPersonalRunProcessor>;
