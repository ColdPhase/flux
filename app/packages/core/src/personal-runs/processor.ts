import { randomUUID } from 'node:crypto';
import { PERSONAL_RUN_LIMITS, type AiPrice } from '@flux/contracts';
import { boundedInputTokens, conservativeTokenEstimate } from '../ai/estimate.js';
import { ForbiddenError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { JobRetryPolicy } from '../push/config.js';
import { isId } from '../work/validation.js';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup,
  PersonalRunPorts, PersonalRunUnitOfWork, RunChanges, RunRecord,
} from './ports.js';
import { updateAndAnnounce } from './progress.js';
import { centsToMicros, parseOutput, requestInput, runChargeMicros, runTokensWithinLimits, SYSTEM_PROMPT, type SuppliedSource } from './validation.js';

// The worker side of a personal run (`personal-run.dispatch.v1`, O-008 §3–§5). The job payload
// is the run id only. Before reading, before dispatch and inside the commit transaction the run
// is checked again: the owner's enablement (pause, removal), the owner's own connection, the
// agent (`agent.invoke`), the agent's and owner's current project access, and before dispatch
// the daily cap. A run refused before dispatch costs zero and releases its reservation. After
// dispatch the observed usage is charged, but a refusal at commit stores nothing: the answer is
// withheld and no proposal is created. There is never another payer or connection to fall back to.

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
  if (run.targetSketchId && run.targetThoughtId) {
    // Agents never see private sketches; the thought must be on a project sketch of this project.
    if (!(await ports.access.canReadSketch(agent, run.targetSketchId))) return null;
    const thought = await ports.runs.thought(run.targetSketchId, run.targetThoughtId);
    if (!thought || thought.sketchScope !== 'project' || thought.sketchProjectId !== run.projectId) return null;
    sources.push({ label: next(), ref: { type: 'thought', id: thought.id, sketchId: thought.sketchId, revision: thought.version }, text: `Selected map thought: ${thought.text}` });
  }
  for (const message of await ports.runs.messages(run.conversationId, MESSAGE_WINDOW))
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
 * run may no longer send anything.
 */
async function fit(compute: PersonalCompute, base: Omit<PersonalComputeRequest, 'input'>, run: RunRecord,
  read: { sources: SuppliedSource[]; earlier: string | null }, beforeCount: () => Promise<PersonalRunOutcome | null>) {
  let sources = read.sources;
  for (;;) {
    const request = { ...base, input: requestInput(run, sources, read.earlier) };
    let tokens = conservativeTokenEstimate([request.system, request.input]);
    if (tokens <= PERSONAL_RUN_LIMITS.maxInputTokens && compute.countInputTokens) {
      const refused = await beforeCount();
      if (refused) return { refused: true as const, outcome: refused };
      tokens = boundedInputTokens(tokens, await compute.countInputTokens(request));
    }
    if (tokens <= PERSONAL_RUN_LIMITS.maxInputTokens) return { refused: false as const, request, sources };
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

export function createPersonalRunProcessor({ uow, connections, compute, stopPollMs = 250, hooks = {} }: PersonalRunProcessorDeps) {
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

  async function commit(runId: string, result: PersonalComputeResult, sources: SuppliedSource[], price: AiPrice | null): Promise<PersonalRunOutcome> {
    return uow.run(async (ports) => {
      const located = await ports.runs.findRun(runId);
      if (!located || located.status !== 'dispatching') return 'skipped';
      const initial = await recheck(ports, connections, compute, located, 'before_commit', true).catch((error: unknown) => { if (isAccessDenial(error)) return { refusal: 'denied' as const }; throw error; });
      const preview = result.kind === 'completed' ? parseOutput(result.text, sources, result.stopReason !== 'max_tokens') : null;
      const refs = [...sources.map((source) => source.ref), ...(preview?.proposal?.finishesWorkId ? [{ type: 'work', id: preview.proposal.finishesWorkId }] : [])];
      const taskFence = !('refusal' in initial) && preview
        ? await ports.runs.prepareTaskUse(located.projectId, located.conversationId, refs) : null;
      const run = await ports.runs.findRun(runId, { lock: true });
      if (!run || run.status !== 'dispatching') return 'skipped';
      // The usage is charged at the price of the connection the run was reserved on, or as the
      // provider reported it (PROV-3), never above the run's reservation. Usage beyond the run's
      // token limits, or a cost above its reservation, is treated as a lost response: the cost is
      // unknown, the whole reservation stays counted against the daily cap, the reported numbers
      // are not stored, and the answer is withheld. Without a price the charge stays unknown too.
      const usage = result.kind === 'completed' ? result.usage : null;
      const tokens: RunChanges = usage && runTokensWithinLimits(usage) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {};
      const chargedMicros = usage && price ? runChargeMicros(usage, price, run.reservedMicros) : null;
      const outOfBounds = usage !== null && price !== null && chargedMicros === null;
      const charge: RunChanges = chargedMicros !== null ? { costState: 'observed', chargedMicros, ...tokens }
        : result.kind === 'completed' && !outOfBounds ? { costState: 'unknown', chargedMicros: 0, ...tokens }
          : result.kind === 'failed' && result.billed === 'none' ? { ...free } : { costState: 'unknown', chargedMicros: 0 };
      if (run.stopRequestedAt) return (await updateAndAnnounce(ports, run.id, ended('stopped', 'before_commit', charge))).status;
      if (result.kind === 'failed' || outOfBounds) return (await updateAndAnnounce(ports, run.id, ended('provider_failed', null, charge))).status;
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
      const parsed = parseOutput(result.text, sources, !truncated);
      const agent: Principal = { kind: 'agent', id: run.agentId };
      const committedAt = new Date();
      const updated = await updateAndAnnounce(ports, run.id, ended(truncated ? 'truncated' : 'completed', null, {
        ...charge, answerBody: parsed.body || (parsed.proposal ? 'Drafted a proposal.' : '(No answer text.)'),
        answerTruncated: truncated, answerSources: parsed.sources, committedAt,
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

  return {
    /** One dispatch job. Returns the run's final status, or `skipped` for a run that is not queued. */
    async process(runId: unknown): Promise<PersonalRunOutcome> {
      if (!isId(runId)) return 'skipped';
      const id = runId.toLowerCase();
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
      let fitted: Awaited<ReturnType<typeof fit>>;
      try {
        fitted = await fit(compute, {
          connection: { id: connection.id, keyRef: connection.keyRef, provider: connection.provider, baseUrl: connection.baseUrl }, model: run.model,
          maxTokens: PERSONAL_RUN_LIMITS.maxOutputTokens, effort: PERSONAL_RUN_LIMITS.effort, system: SYSTEM_PROMPT,
        }, run, read, beforeSend);
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
      return commit(run.id, result, ready.fitted.sources, connection.price);
    },
  };
}

export type PersonalRunProcessor = ReturnType<typeof createPersonalRunProcessor>;
