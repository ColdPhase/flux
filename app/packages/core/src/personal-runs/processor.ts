import { randomUUID } from 'node:crypto';
import { PERSONAL_RUN_LIMITS, personalRunMaxInputTokens, RUNTIME_RUN_LIMITS, type AiPrice } from '@flux/contracts';
import { boundedInputTokens, conservativeTokenEstimate } from '../ai/estimate.js';
import { ForbiddenError, NotFoundError, SpaceAiOffError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { JobRetryPolicy } from '../push/config.js';
import { isId } from '../work/validation.js';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup,
  PersonalRunPorts, PersonalRunTokenIssuer, PersonalRunUnitOfWork, PersonalRuntime, PersonalToolHost, PersonalToolSession, RunChanges, RunEndStatus, RunRecord,
} from './ports.js';
import { connectionOnModel } from './model.js';
import { redactSecrets } from './redaction.js';
import { answerWithSchedule } from './schedule-request.js';
import { createRuntimeRunProcessor, type RuntimeCaps } from './runtime-run.js';
import { reserveOnKey } from './service.js';
import { updateAndAnnounce } from './progress.js';
import { requestParts, runToolLoop, type LoopResult, type RunAccount } from './tool-loop.js';
import {
  centsToMicros, connectionCallsTools, MORNING_SUMMARY_SYSTEM_PROMPT, parseOutput, requestInput, runChargeMicros, runReservationMicros, runTokensWithinLimits, SYSTEM_PROMPT, TOOL_SYSTEM_PROMPT, type SuppliedSource,
} from './validation.js';

// The worker side of a personal run (`personal-run.dispatch.v1`, O-008 §3–§5). The job payload
// is the run id only. Before reading, before dispatch and inside the commit transaction the run
// is checked again: the owner's enablement (pause, removal), the owner's own connection, the
// agent (`agent.invoke`), the agent's and owner's current project access, and before dispatch
// the API key's daily budget (#854). A run refused before dispatch costs zero and releases its
// reservation. After dispatch the observed usage is charged, but a refusal at commit stores
// nothing: the answer is withheld and no proposal is created. There is never another payer or
// connection to fall back to.
//
// A run with tools (F-027 AST-8, `tools` below and `tool-loop.ts`) is a loop of such requests: the
// same rechecks run before every further request, each request is reconciled by itself against
// the run's reservation, and a run that uses up what was left of the key's daily budget ends
// `cap_reached` with `budget`, keeping the changes it already made. The step count and the clock
// are technical safety bounds only (#843). A run without tools, or on a model that cannot call
// them, is one request.

export const PERSONAL_RUN_JOB = 'personal-run.dispatch.v1';

/**
 * Never retried by the queue (O-008 §4): a failed dispatch ends the run; the owner retries as a new run. The job outlives
 * the run's own safety clock (#843).
 */
export const PERSONAL_RUN_QUEUE: Pick<JobRetryPolicy, 'retryLimit' | 'expireInSeconds' | 'deleteAfterSeconds'> = {
  retryLimit: 0,
  expireInSeconds: RUNTIME_RUN_LIMITS.wallClockSeconds + 600,
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
  /** The most requests of one run with tools; at most {@link PERSONAL_RUN_LIMITS}`.maxTurns`, a safety bound (#843). */
  maxTurns?: number;
  /** The safety clock of a run with tools (#843: an hour, the same as on a plan). */
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
type Refusal = Extract<RunRecord['status'], 'denied' | 'paused' | 'revoked' | 'unavailable' | 'cap_reached'> | 'ai_off';

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
  // AG-10, first: AI on in the run's space, at the epoch the run was admitted under (policy row before the others).
  const ai = await ports.access.spaceAi(run.projectId, { lock });
  if (ai.state !== 'allowed' || ai.epoch !== run.aiEpoch) return { refusal: 'ai_off' };
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
  // Exactly the connection the run was started on (PROV-1), never the owner's newest or another. Choosing another model
  // for the next request does not touch a request already sent.
  const connection = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== run.ownerUserId
    || connection.id !== run.connectionId) return { refusal: 'unavailable' };
  // The sources are what the owner can read in this project, as the agent;
  // the answer is posted to the place, so its owner must still be able to write there.
  if (!(await ports.access.canUseProject(owner, 'write', run.projectId, { lock })) || !(await ports.access.canUseProject(agent, 'read', run.projectId, { lock })))
    return { refusal: 'denied' };
  if (stage === 'before_dispatch') {
    // The key's one daily budget (#854): what the rest of the day's work holds, and this run's own reservation.
    const spend = await ports.runs.keySpend(connection, run.id);
    if (!spend || spend.chargedMicros + spend.reservedMicros + run.reservedMicros > centsToMicros(spend.budgetCents)) return { refusal: 'cap_reached' };
  }
  return { connection };
}

/** How a run ends. `cap_reached` without another reason is the API key's daily budget (#854): Flux has no other cap. */
const ended = (status: RunEndStatus, stage: Stage | null, extra: RunChanges = {}): RunChanges => status === 'ai_off'
  ? { status: 'stopped', stoppedAtStage: stage, completedAt: new Date(), ...extra, endReason: 'ai_off' }
  : { status, stoppedAtStage: stage, completedAt: new Date(), ...(status === 'cap_reached' ? { endReason: 'budget' as const } : {}), ...extra };
const free: RunChanges = { costState: 'released', chargedMicros: 0 };

/** F-029: a stop request the turn-off sweep made ends the run `ai_off`; the owner's own Stop stays `stopped`. */
async function stopped(ports: PersonalRunPorts, run: RunRecord): Promise<RunEndStatus> {
  const ai = await ports.access.spaceAi(run.projectId);
  return ai.state !== 'allowed' || ai.epoch !== run.aiEpoch ? 'ai_off' : 'stopped';
}

/** Reads the project-audience sources of the run as its agent. Private places are never read. */
async function readSources(ports: PersonalRunPorts, run: RunRecord): Promise<{ sources: SuppliedSource[]; earlier: string | null } | null> {
  const agent: Principal = { kind: 'agent', id: run.agentId };
  // AG-10: the reads run under the policy row's share lock, at the run's admission epoch (a read after the change sees it).
  await ports.access.requireSpaceAi(run.projectId, { lock: true, epoch: run.aiEpoch });
  await ports.access.requireProject(agent, 'read', run.projectId);
  const sources: SuppliedSource[] = [];
  const next = () => `S${sources.length + 1}`;
  // The morning summary (F-027 AST-7) reads nothing of its own: Flux gives it the facts in its request.
  if (run.kind === 'morning_summary') return { sources, earlier: null };
  if (run.targetSketchId && run.targetThoughtId) {
    // Agents never see private sketches; the thought must be on a project sketch of this project.
    if (!(await ports.access.canReadSketch(agent, run.targetSketchId))) return null;
    const thought = await ports.runs.thought(run.targetSketchId, run.targetThoughtId);
    if (!thought || thought.sketchScope !== 'project' || thought.sketchProjectId !== run.projectId) return null;
    sources.push({ label: next(), ref: { type: 'thought', id: thought.id, sketchId: thought.sketchId, revision: thought.version }, text: `Selected map thought: ${thought.text}` });
  }
  // A silent background run's conversation is only where it is anchored: its messages are not its context (AST-9).
  for (const message of !run.silent ? await ports.runs.messages(run.conversationId, MESSAGE_WINDOW) : [])
    sources.push({ label: next(), ref: { type: 'message', id: message.id, revision: 1 }, text: `Message ${message.sequence}${message.contribution ? ` (${message.contribution.kind}${message.contribution.kind === 'result' ? `; result ${message.contribution.resultId}` : ''})` : ''} by ${message.authorName}${message.author.kind === 'agent' ? ' (agent)' : ''}: ${message.body}${message.files?.length ? `\nAttached files (contents not included): ${message.files.map((file) => `${file.name} (${file.size} bytes; file ${file.id})`).join(', ')}` : ''}` });
  for (const work of await ports.runs.openWork(run.projectId, WORK_WINDOW))
    sources.push({ label: next(), ref: { type: 'work', id: work.id, revision: work.version }, text: `Open work item "${work.title}" (${work.status})${work.outcome ? `: ${work.outcome}` : ''}` });
  let earlier: string | null = null;
  if (run.continuesRunId) {
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

/** The safety clock of a run with tools (#843): the same as a run on a plan. */
const WALL_CLOCK_MS = RUNTIME_RUN_LIMITS.wallClockSeconds * 1000;

export function createPersonalRunProcessor({ uow, connections, compute, stopPollMs = 250, hooks = {}, tools, maxTurns = PERSONAL_RUN_LIMITS.maxTurns,
  wallClockMs = WALL_CLOCK_MS, now = Date.now, runtime, tokens, runtimeCaps }: PersonalRunProcessorDeps) {
  const runtimeRuns = createRuntimeRunProcessor({ uow, runtime, tokens, stopPollMs, hooks, now, ...(runtimeCaps ? { caps: runtimeCaps } : {}) });
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
    // response: the cost is unknown, the reservation stays counted against the key's daily budget, the
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
   * is the charge. A request that may have been billed without a usable report ends the run: what the
   * earlier requests cost and the most that one could have cost stay counted as `unknown`, and the rest
   * of the reservation is released (#854), so a Stop never uses up the key's day.
   */
  function settleAccount(run: RunRecord, account: RunAccount, price: AiPrice | null): Settlement {
    if (account.unknown) {
      const lost = account.micros + (runReservationMicros(price, true) ?? run.reservedMicros);
      return { charge: { costState: 'unknown', chargedMicros: 0, reservedMicros: Math.min(run.reservedMicros, lost) }, withhold: true };
    }
    if (account.requests === 0) return { charge: { ...free }, withhold: false };
    return { charge: { costState: 'observed', chargedMicros: account.micros, inputTokens: account.inputTokens, outputTokens: account.outputTokens }, withhold: false };
  }

  /** How a run that did not end in an answer is closed: at one of its own bounds, or at a standing check. */
  type Early = { status: RunEndStatus; stage: Stage; endReason?: RunRecord['endReason'] };

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
      // F-029: a run stopped because AI was turned off (the sweep's stop request, or the check itself) says so; nothing is posted.
      if ('refusal' in initial && initial.refusal === 'ai_off') return (await updateAndAnnounce(ports, run.id, ended('ai_off', 'before_commit', charge))).status;
      if (run.stopRequestedAt) return (await updateAndAnnounce(ports, run.id, ended('stopped', 'before_commit', charge))).status;
      // A tool result passed the MCP route's bound (F-022 "Caps"): the run ends in its own state, nothing is posted.
      if (run.mcpLimit) return (await updateAndAnnounce(ports, run.id, ended('cap_reached', 'before_commit', { ...charge, endReason: 'mcp_results_too_large' }))).status;
      if (early) return (await updateAndAnnounce(ports, run.id, ended(early.status, early.stage, { ...charge, ...(early.endReason ? { endReason: early.endReason } : {}) }))).status;
      // A `tool_use` stop here means a request without tools came back asking for some: its text is
      // half an answer to a call that will never be made, so nothing is posted (the cost stays as observed).
      if (!result || result.kind === 'failed' || withhold || result.stopReason === 'tool_use') {
        const credits: RunChanges = result?.kind === 'failed' && result.reason === 'no_credits' ? { endReason: 'credits' } : {};
        return (await updateAndAnnounce(ports, run.id, ended('provider_failed', null, { ...charge, ...credits }))).status;
      }
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
      parsed.body = await answerWithSchedule(ports, run, parsed.body);
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
      // A silent background run is not announced to the project: its result is the owner's (Recent, the Inbox).
      if (!run.silent) await ports.events.record(agent, run.workspaceId, 'project.assistant_answer_committed.v1', run.projectId, { conversationId: run.conversationId, runId: run.id });
      await taskFence?.mark();
      return updated.status;
    });
  }

  /** The loop's end, as the run's commit: an answer is committed like a single request's; every other end closes the run. */
  function commitLoop(runId: string, loop: LoopResult, sources: SuppliedSource[], price: AiPrice | null): Promise<PersonalRunOutcome> {
    const settle = (run: RunRecord) => settleAccount(run, loop.account, price);
    const { end } = loop;
    switch (end.kind) {
      case 'answer': return commit(runId, end.result, sources, settle);
      case 'failed': return commit(runId, end.result, sources, settle);
      case 'lost': return commit(runId, null, sources, settle);
      // The key's daily budget, or a safety bound (steps, the clock, one request's input).
      case 'limit': return commit(runId, null, sources, settle, end.limit === 'input' ? { status: 'input_too_large', stage: 'before_dispatch' }
        : { status: 'cap_reached', stage: 'before_dispatch', endReason: end.limit === 'money' ? 'budget' : end.limit === 'turns' ? 'max_turns' : 'wall_clock' });
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
        system: run.kind === 'morning_summary' ? MORNING_SUMMARY_SYSTEM_PROMPT : session ? TOOL_SYSTEM_PROMPT : SYSTEM_PROMPT, ...(session ? { tools: session.tools } : {}),
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
      const end = async (status: RunEndStatus) => ({ done: true as const, outcome: (await updateAndAnnounce(ports, run.id, ended(status, 'before_dispatch', free))).status as PersonalRunOutcome });
      if (!current || current.status !== 'reading') return { done: true as const, outcome: 'skipped' as PersonalRunOutcome };
      if (current.stopRequestedAt) return end(await stopped(ports, current));
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
      const gate = (spentMicros: number): Promise<{ status: RunEndStatus | 'gone' } | null> => uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'dispatching') return { status: 'gone' as const };
        if (current.stopRequestedAt) return { status: await stopped(ports, current) };
        if (current.mcpLimit) return { status: 'cap_reached' as const };
        const checked = await recheck(ports, connections, compute, current, 'before_dispatch', true).catch((error: unknown) => {
          if (isAccessDenial(error)) return { refusal: 'denied' as const };
          throw error;
        });
        if ('refusal' in checked) return { status: checked.refusal };
        if (checked.connection.id !== connection.id) return { status: 'unavailable' as const };
        // What was spent so far stays on the row: a lost worker counts it and one more request, not the whole reservation.
        await ports.runs.updateRun(run.id, { chargedMicros: spentMicros });
        return null;
      });
      let loop: LoopResult;
      try {
        loop = await runToolLoop({
          compute, session, first: ready.fitted.request, price: connection.price!, reservedMicros: run.reservedMicros,
          maxTurns: Math.max(1, Math.min(maxTurns, PERSONAL_RUN_LIMITS.maxTurns)), deadline: now() + wallClockMs, now, gate, signal: controller.signal,
        });
      } catch {
        // An unexpected failure inside the loop is a lost response: its largest cost stays counted.
        loop = { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'unknown' } }, account: { micros: 0, inputTokens: 0, outputTokens: 0, requests: 0, unknown: true }, turns: 0 };
      } finally {
        stopWatching();
      }
      await hooks.afterDispatch?.(run);
      return commitLoop(run.id, loop, ready.fitted.sources, connection.price);
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
        // A request paused by the key's daily budget waits for its resume time (#854).
        if (run.resumeAt && run.resumeAt.getTime() > now()) return null;
        // One lane per owner: a request behind the one that is working waits for it to end (AST-6 queue).
        await ports.runs.lockLane(run.ownerUserId);
        if (await ports.runs.laneBusy(run.ownerUserId, run.id)) return null;
        const checked = await recheck(ports, connections, compute, run, 'before_read', true).catch((error: unknown) => {
          if (isAccessDenial(error)) return { refusal: 'denied' as const };
          throw error;
        });
        if ('refusal' in checked) return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended(checked.refusal, 'before_read', free))).status };
        // Its turn in the owner's lane: it reserves now against what is left of the key's daily budget (#854), or waits for
        // the key's next day when not even one request fits.
        const onModel = connectionOnModel(checked.connection, run.model);
        const withTools = !!tools && !!onModel && connectionCallsTools(onModel) && run.kind !== 'morning_summary';
        const held = onModel ? await reserveOnKey(ports, onModel, withTools, Math.max(1, Math.min(maxTurns, PERSONAL_RUN_LIMITS.maxTurns)), run.id) : null;
        if (!held) return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended('unavailable', 'before_read', free))).status };
        if ('paused' in held) {
          // A background run does not wait for tomorrow: its next firing is its next chance.
          if (run.authority !== 'owner_request') return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended('cap_reached', 'before_read', free))).status };
          await updateAndAnnounce(ports, run.id, { resumeAt: held.paused, endReason: 'budget' });
          return null;
        }
        return { done: false as const, run: await updateAndAnnounce(ports, run.id, { status: 'reading', reservedMicros: held.reservedMicros, reservedAt: new Date(),
          largestRequestMicros: held.largestRequestMicros, resumeAt: null, endReason: null }) };
      });
      if (!claimed) return 'skipped';
      if (claimed.done) return claimed.status;
      const run = claimed.run;

      const read = await uow.run((ports) => readSources(ports, run)).catch((error: unknown) => {
        if (error instanceof SpaceAiOffError) return 'ai_off' as const;
        if (isAccessDenial(error)) return null;
        throw error;
      });
      if (!read || read === 'ai_off') {
        return uow.run(async (ports) => {
          const current = await ports.runs.findRun(run.id, { lock: true });
          if (current?.status !== 'reading') return 'skipped' as const;
          return (await updateAndAnnounce(ports, run.id, ended(read === 'ai_off' ? 'ai_off' : 'denied', 'before_read', free))).status;
        });
      }
      await hooks.afterRead?.(run);

      // Preflight counting is a provider call that sends the input: it runs outside any
      // transaction, on the owner's own connection, and only after the same recheck as a dispatch
      // (stop, enablement, agent, owner and agent access, cap, connection) before every request.
      // On the model the run was sent with (F-027 AST-11), at that model's price; a change made since never reaches it.
      const named = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
      const connection = named ? connectionOnModel(named, run.model) : null;
      const beforeSend = (): Promise<PersonalRunOutcome | null> => uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'reading') return current?.status ?? 'skipped';
        const end = async (status: RunEndStatus) => (await updateAndAnnounce(ports, run.id, ended(status, 'before_dispatch', free))).status;
        if (current.stopRequestedAt) return end(await stopped(ports, current));
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
      if (tools && connection.price && connectionCallsTools(connection) && run.kind !== 'morning_summary') {
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
      // A ready-PR event needs current G-1 proof at dispatch, including a model without tool calling.
      const needsGithub = run.kind === 'reaction' && await uow.run(async (ports) => await ports.runs.needsCurrentGithubFacts?.(run.id) ?? false);
      let context = session?.context;
      let separateGrant = false;
      if (needsGithub && !context && !session && tokens) {
        const grant = await tokens.issue(run.id).catch(() => null);
        context = grant?.context; separateGrant = !!grant;
      }
      try {
        if (needsGithub && !context) return uow.run(async (ports) => (await updateAndAnnounce(ports, run.id, ended('unavailable', 'before_dispatch', free))).status);
        return await dispatchRun(context ? { ...run, prompt: `${run.prompt}\n${context}` } : run, read, connection, session, beforeSend);
      } finally {
        await session?.close().catch(() => undefined);
        if (separateGrant) await tokens?.close(run.id).catch(() => undefined);
      }
    },
  };
}
