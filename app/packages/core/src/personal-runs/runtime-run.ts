import { randomUUID } from 'node:crypto';
import { aiModelSeesPictures, ASSISTANT_RUN_CHANGED_EVENT, RUNTIME_RUN_LIMITS, type AssistantRunEndReason } from '@flux/contracts';
import { ForbiddenError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type {
  AgentBrief,
  PersonalRunPorts, PersonalRunTokenIssuer, PersonalRunUnitOfWork, PersonalRuntime, PersonalRuntimeEnd, PersonalRuntimeEvent, PersonalRuntimeRunRequest,
  RunChanges, RunEndStatus, RunLiveText, RunRecord,
} from './ports.js';
import { liveText } from './live-text.js';
import { announce, updateAndAnnounce } from './progress.js';
import { redactSecrets } from './redaction.js';
import { runtimeModelFlag } from './model.js';
import { answerWithSchedule, preparedAnswer } from './schedule-request.js';
import { placeAllows, spaceSwitchAllows } from './place.js';
import { isAsked, isPrivateAnswer } from './ports.js';
import { briefPrivateText, runtimeBrief, type BriefInput, type SuppliedSource } from './brief.js';
import { CHAT_TURNS, latestMessages, readBriefFacts, type BriefFacts } from './brief-facts.js';
import { answerCleaner } from './answer-addresses.js';
import { answerWithWebSources } from './web-sources.js';
import { withoutInventedMarks } from './answer-marks.js';
import { addressesIn, boundedWebSearch, keepPrivateText, WEB_SEARCH_BOUNDS } from './web-addresses.js';

// A personal run on the owner's own Claude Code in the agent runtime (F-022 AIM-3 "Run", #280; F-027 A2).
//
// The worker never reads a space's content for this engine: the CLI reads Flux itself through the MCP
// route with the run's token, which reaches only the run's place, lists exactly the run's tools (from the
// owner's switches) and bounds what tools return. The worker reads only what the brief names (#1064: the
// owner, the space, the task) and what no tool reads (a DM's messages, a chat's earlier turns). The same standing checks as an API-key run hold before
// the CLI starts, while it runs (stop, revocation, a result bound) and inside the commit transaction. A run
// costs no money in Flux and has no Flux limit (#843): the plan's own limits apply, and the clock, steps,
// MCP result size and answer size are technical safety bounds nobody meets in normal use. Every end has its
// own state (`endReason`); nothing falls back to another connection, and a broken stream ends `unknown` and
// is never rerun. A request that meets the plan's limit pauses: it waits, queued, and starts again by itself
// when the plan resets (#854). The committed answer has token-shaped strings and the run token removed.

export type RuntimeRunOutcome = RunRecord['status'] | 'skipped';
export type Stage = 'before_read' | 'before_dispatch' | 'before_commit';
export type Refusal = Extract<RunRecord['status'], 'denied' | 'revoked' | 'unavailable' | 'cap_reached'> | 'ai_off';

export type RuntimeCaps = PersonalRuntimeRunRequest['caps'];

/**
 * API-key runs in pi (#1441, RT-1): the processor's own standing checks of a key run (the connection the run was started on, the operator's
 * provider switch, the key's budget before dispatch), and the claim's check that at least one request fits in what is left of the key's
 * daily budget today. Flux's model gateway reserves and charges each request of the run on the run's own row (CA-3), so the run reserves
 * nothing up front here.
 */
export interface KeyRunGateway {
  issue(runId: string): Promise<{ token: string } | null>;
  close(runId: string): Promise<{ unknown: number; stopped: 'budget' | 'ended' | null }>;
  /** Called the moment the gateway refuses one of the run's requests for the key's budget or the run's standing; returns the unwatch. */
  watch?(runId: string, listener: (reason: 'budget' | 'ended') => void): () => void;
}

export interface KeyRunDeps {
  /**
   * Flux's model gateway (RT-4 "The model gateway"): a token for the run's model requests, issued once the run is working and closed at its
   * end with what its requests came to. Absent (the gateway is off on this worker): a key run cannot start.
   */
  gateway?: KeyRunGateway | undefined;
  check(ports: PersonalRunPorts, run: RunRecord, stage: Stage, lock: boolean): Promise<Refusal | null>;
  /** `paused`: not even one request fits today; the request waits for the key's next day (#854). */
  fits(ports: PersonalRunPorts, run: RunRecord): Promise<'ok' | { paused: Date } | 'unavailable'>;
}

export interface RuntimeRunDeps {
  uow: PersonalRunUnitOfWork;
  runtime?: PersonalRuntime | undefined;
  tokens?: PersonalRunTokenIssuer | undefined;
  stopPollMs: number;
  hooks: { afterDispatch?: (run: RunRecord) => Promise<void> };
  /** Lower bounds for tests; production uses RUNTIME_RUN_LIMITS (#843: safety bounds only). */
  caps?: Partial<RuntimeCaps>;
  now?: () => number;
  /** The asker's live view (#1248): the words the CLI streams for `/ai` and a chat, and the Flux tool it uses now. */
  live?: RunLiveText;
  /** Present: this processor runs API-key agents in pi (#1441), not plan CLIs. */
  key?: KeyRunDeps;
}

/** Claude Code's own shell and file tools, which a run keeps in Flux's per-run sandbox (#1437, RT-5; the supervisor's `CLAUDE_OWN_TOOLS`). */
export const RUNTIME_OWN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

/**
 * The CLI's start-up tool list may name only the run's exact Flux tools (and `EndConversation`, on Claude Code with the web on its own
 * `WebSearch`, #1065, and where the slot says the run has them in its sandbox, its own shell and file tools, #1437), and only a connected
 * Flux server.
 */
export function localToolInInit(event: Extract<PersonalRuntimeEvent, { kind: 'init' }>, tools: readonly string[], webSearch = false): boolean {
  const allowed = new Set([...tools.map((tool) => `mcp__flux__${tool}`), 'EndConversation', ...(webSearch ? ['WebSearch'] : []),
    ...(event.own ? RUNTIME_OWN_TOOLS : [])]);
  if (event.tools.some((tool) => !allowed.has(tool))) return true;
  return event.mcpServers.length !== 1 || event.mcpServers[0]!.name !== 'flux' || event.mcpServers[0]!.status !== 'connected';
}

const ended = (status: RunEndStatus, stage: Stage | null, extra: RunChanges = {}): RunChanges => status === 'ai_off'
  ? { status: 'stopped', stoppedAtStage: stage, completedAt: new Date(), ...extra, endReason: 'ai_off' }
  : { status, stoppedAtStage: stage, completedAt: new Date(), ...extra };
/** Before the CLI ran nothing was used. */
const free: RunChanges = { costState: 'released', chargedMicros: 0 };
/** After it ran, the plan's usage is not visible to Flux (F-022 "Payer and data"): unknown, never zero. */
const used: RunChanges = { costState: 'unknown', chargedMicros: 0 };
/**
 * After a key run in pi (#1441): the model gateway has charged each request on the run's row; the run's cost is what it charged
 * (`observed`), nothing (`released`), or unknown where the gateway lost a response.
 */
const keySettled = (current: RunRecord, unknown: boolean): RunChanges => unknown || current.costState === 'unknown' ? { costState: 'unknown' }
  : { costState: current.chargedMicros > 0 ? 'observed' : 'released' };

/** How each end of the CLI is recorded: its status, and the reason when the status alone does not say. */
function endChanges(reason: AssistantRunEndReason | 'stopped' | 'unavailable' | 'input_too_large', planResetsAt: Date | null | undefined, used: RunChanges): RunChanges {
  switch (reason) {
    case 'stopped': return ended('stopped', 'before_commit', used);
    // #1129: longer than the model's context window, as an API-key run that does not fit: the same status and words.
    case 'input_too_large': return ended('input_too_large', null, used);
    case 'unavailable': return ended('unavailable', 'before_dispatch', used);
    case 'sign_in_again': case 'local_tool': case 'slot_busy': case 'model_unavailable':
      return ended('unavailable', null, { ...used, endReason: reason });
    case 'plan_limit': return ended('unavailable', null, { ...used, endReason: reason, planLimitResetsAt: planResetsAt ?? null });
    case 'wall_clock': case 'max_turns': case 'answer_too_large': case 'mcp_results_too_large':
      return ended('cap_reached', null, { ...used, endReason: reason });
    case 'no_event': case 'crashed': case 'unknown': case 'refused':
      return ended('provider_failed', null, { ...used, endReason: reason });
    // F-029: the CLI was stopped because AI was turned off in the run's workspace.
    case 'ai_off': return ended('ai_off', 'before_commit', used);
    // A plan has no budget or API credits and an API key's run never comes here; a run that waited for room is claimed, not ended.
    // A key run in pi (#1441): the gateway refused for the key's daily budget, or the provider for its credits (a plan has neither).
    case 'budget': return ended('cap_reached', null, { ...used, endReason: 'budget' });
    case 'credits': return ended('provider_failed', null, { ...used, endReason: 'credits' });
    // A run that waited for room is claimed, not ended.
    case 'no_room': return ended('provider_failed', null, used);
  }
}

function isAccessDenial(error: unknown) {
  return error instanceof NotFoundError || error instanceof ForbiddenError;
}

/**
 * Automatic resumes of one request in a row (#854): a request that meets the plan's limit again right after its reset
 * waits for the owner instead of looping. A technical safety bound.
 */
export const MAX_AUTO_RESUMES = 3;

/** How long a request waits to try again when the plan gave no reset time (#854): the longest usual window is five hours. */
export const PLAN_RETRY_MS = 2 * 3600_000;

/**
 * The plan's limit paused an owner's request (#854): it waits, queued, and starts again by itself when the plan resets, or
 * tries again later when the CLI gave no time. At most {@link MAX_AUTO_RESUMES} times in a row. A schedule's firing is not
 * resumed (its next firing is its next chance), and neither is a request that already changed something: a second try would
 * repeat it, so it ends with its line and how many changes were made. Inside the ending transaction.
 */
async function pauseUntilReset(ports: PersonalRunPorts, run: RunRecord, resetsAt: Date | null | undefined, now: number): Promise<void> {
  if (run.authority !== 'owner_request' || await ports.runs.changeCount(run.id)) return;
  const known = resetsAt && resetsAt.getTime() > now ? resetsAt : null;
  let depth = 0;
  for (let earlier = run; earlier.retryOfRunId && depth < MAX_AUTO_RESUMES; depth++) {
    const previous = await ports.runs.findRun(earlier.retryOfRunId);
    if (!previous || previous.endReason !== 'plan_limit') break;
    earlier = previous;
  }
  if (depth >= MAX_AUTO_RESUMES) return;
  const resumed = await ports.runs.insertRun({
    id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId, conversationId: run.conversationId, dmId: run.dmId, dmThreadRootId: run.dmThreadRootId, ownerUserId: run.ownerUserId,
    agentId: run.agentId, connectionId: run.connectionId, clientRunId: randomUUID(), requestFingerprint: run.requestFingerprint, kind: run.kind,
    prompt: run.prompt, targetSketchId: run.targetSketchId, targetThoughtId: run.targetThoughtId, continuesRunId: run.continuesRunId, retryOfRunId: run.id,
    workId: run.workId, askedByRunId: run.askedByRunId, exchangeTurn: run.exchangeTurn, reservedMicros: 0, provider: run.provider, model: run.model, aiEpoch: run.aiEpoch, engine: 'runtime',
    resumeAt: known ?? new Date(now + PLAN_RETRY_MS), endReason: 'plan_limit', planLimitResetsAt: known,
  });
  await announce(ports, resumed);
}

/** What the worker reads for the CLI's brief (#1064), after the same place checks as an API-key run's read. */
interface RuntimeContext { brief: AgentBrief | null; facts: BriefFacts; sources: SuppliedSource[]; leftOut: boolean; turns: { prompt: string; answer: string }[] }

/**
 * The CLI reads a space itself, through the run's tools. A direct message has no tool that reads it, and a chat remembers its earlier turns:
 * Flux gives those in the request (#842), with the brief's names and times.
 */
async function runtimeContext(ports: PersonalRunPorts, run: RunRecord): Promise<RuntimeContext> {
  const { projectId, dmId } = run;
  if (projectId !== null) {
    await ports.access.requireSpaceAi(projectId, { lock: true, epoch: run.aiEpoch! });
    await ports.access.requireProject({ kind: 'agent', id: run.agentId }, 'read', projectId);
  } else if (dmId !== null) await ports.access.requireDm({ kind: 'human', id: run.ownerUserId }, dmId);
  const brief = await ports.runs.agentBrief(run.agentId);
  const dm = dmId !== null && isPrivateAnswer(run) ? await latestMessages((limit) => ports.runs.dmMessages(dmId, limit, run.dmThreadRootId)) : { messages: [], leftOut: false };
  const turns = projectId === null && dmId === null && isAsked(run) ? await ports.runs.chatTurns(run.agentId, run.id, CHAT_TURNS) : [];
  return {
    brief, facts: await readBriefFacts(ports, run, brief), leftOut: dm.leftOut, turns,
    sources: dm.messages.map((message, index) => ({ label: `S${index + 1}`, ref: { type: 'message', id: message.id, revision: 1 }, item: { kind: 'message', message } })),
  };
}

/**
 * The brief without what could not be read: the run goes on, and its tools and the commit's checks still decide what it may do. What the
 * owner gave the agent is its own read, as before #1064, so the agent keeps its instructions and memory.
 */
function unreadContext(run: RunRecord, brief: AgentBrief | null): RuntimeContext {
  return {
    brief, sources: [], leftOut: false, turns: [],
    facts: { ownerName: 'your owner', agentName: brief?.name ?? 'Assistant', agentId: run.agentId, namesake: false, timeZone: 'UTC', task: null, scheduleTitle: null,
      place: run.projectId !== null ? { kind: 'space', spaceId: run.projectId, spaceName: null, conversationId: run.conversationId, task: null }
        : run.dmId !== null ? { kind: 'dm', others: [], thread: run.dmThreadRootId !== null } : { kind: 'chat' } },
  };
}

export function createRuntimeRunProcessor({ uow, runtime, tokens, stopPollMs, hooks, caps: lowered = {}, now = Date.now, live, key }: RuntimeRunDeps) {
  const caps: RuntimeCaps = {
    maxTurns: Math.min(lowered.maxTurns ?? RUNTIME_RUN_LIMITS.maxTurns, RUNTIME_RUN_LIMITS.maxTurns),
    wallClockSeconds: Math.min(lowered.wallClockSeconds ?? RUNTIME_RUN_LIMITS.wallClockSeconds, RUNTIME_RUN_LIMITS.wallClockSeconds),
    idleSeconds: Math.min(lowered.idleSeconds ?? RUNTIME_RUN_LIMITS.idleSeconds, RUNTIME_RUN_LIMITS.idleSeconds),
    maxAnswerBytes: Math.min(lowered.maxAnswerBytes ?? RUNTIME_RUN_LIMITS.maxAnswerBytes, RUNTIME_RUN_LIMITS.maxAnswerBytes),
  };
  /** The owner's standing at one step, as for an API-key run, without a key connection. */
  async function recheck(ports: PersonalRunPorts, run: RunRecord, stage: Stage, lock: boolean): Promise<Refusal | null> {
    // A key run (#1441): the same checks as a key run in the worker, and API keys in pi on this server.
    if (key) return (await key.check(ports, run, stage, lock)) ?? (runtime?.enabled && runtime.keys && tokens ? null : 'unavailable');
    // AG-10, first: AI on in the run's space, at the epoch the run was admitted under.
    if (!(await spaceSwitchAllows(ports, run, lock))) return 'ai_off';
    // A request already sent keeps its connection: choosing another for the next one does not touch it. A deleted agent has no setup.
    if (!(await ports.runs.enablement(run.ownerUserId, { lock, agentId: run.agentId }))) return 'revoked';
    const owner: Principal = { kind: 'human', id: run.ownerUserId };
    if (!(await ports.access.canInvoke(owner, run.agentId, { lock }))) return 'revoked';
    if (!runtime?.enabled || !tokens) return 'unavailable';
    if (ports.runs.assistantConnectionLive && !(await ports.runs.assistantConnectionLive(run.ownerUserId, run.agentId))) return 'revoked';
    if (!(await placeAllows(ports, run, lock))) return 'denied';
    return null;
  }
  const checked = (ports: PersonalRunPorts, run: RunRecord, stage: Stage, lock: boolean) =>
    recheck(ports, run, stage, lock).catch((error: unknown) => { if (isAccessDenial(error)) return 'denied' as const; throw error; });

  /** Ends a run that is still in `from` (a concurrent stop or sweep wins otherwise). */
  function finish(runId: string, from: RunRecord['status'], changes: (run: RunRecord) => RunChanges): Promise<RuntimeRunOutcome> {
    return uow.run(async (ports) => {
      const current = await ports.runs.findRun(runId, { lock: true });
      if (!current || current.status !== from) return 'skipped';
      return (await updateAndAnnounce(ports, runId, changes(current))).status;
    });
  }

  /** While the CLI runs: the owner's stop, a result bound and a revocation each stop it at once. */
  function watch(run: RunRecord, flags: { stop: (why: 'owner' | 'limit' | 'standing' | 'local_tool') => void }) {
    let active = true;
    let polls = 0;
    const loop = async () => {
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, stopPollMs));
        if (!active) return;
        try {
          const current = await uow.run((ports) => ports.runs.findRun(run.id));
          if (!current || current.status !== 'dispatching') return;
          if (current.stopRequestedAt) { flags.stop('owner'); return; }
          if (current.mcpLimit) { flags.stop('limit'); return; }
          // The standing (pause, removal, revoked connection, lost access) about once a second.
          if (++polls % Math.max(1, Math.round(1000 / stopPollMs)) === 0 && await uow.run((ports) => checked(ports, current, 'before_commit', false))) {
            flags.stop('standing'); return;
          }
        } catch {
          // A failed poll only delays the stop; the commit recheck still decides what is posted.
        }
      }
    };
    void loop();
    return () => { active = false; };
  }

  return {
    async process(id: string): Promise<RuntimeRunOutcome> {
      const claimed = await uow.run(async (ports) => {
        const run = await ports.runs.findRun(id, { lock: true });
        if (!run || run.status !== 'queued') return null;
        // A request paused by the plan's limit waits for the plan's reset (#854).
        if (run.resumeAt && run.resumeAt.getTime() > now()) return null;
        // One lane per owner: a request behind the one that is working waits for it to end (AST-6 queue).
        await ports.runs.lockLane(run.ownerUserId);
        if (await ports.runs.laneBusy(run.ownerUserId, run.id)) return null;
        const refusal = await checked(ports, run, 'before_read', true);
        if (refusal) return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended(refusal, 'before_read', free))).status };
        // The server runs as many agents as fit in its memory; the others wait, in order, with one line (#860).
        if (!(await ports.runs.roomForRuntimeRun(runtime?.keys === true))) {
          if (run.endReason !== 'no_room') await updateAndAnnounce(ports, run.id, { endReason: 'no_room', resumeAt: null, planLimitResetsAt: null });
          return null;
        }
        if (key) {
          // A key run starts when at least one request fits in what is left of the key's budget today; the gateway reserves each (#854, CA-3).
          const fits = await key.fits(ports, run);
          if (fits === 'unavailable') return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended('unavailable', 'before_read', free))).status };
          if (fits !== 'ok') {
            // A background run does not wait for tomorrow: its next firing is its next chance.
            if (run.authority !== 'owner_request') return { done: true as const, status: (await updateAndAnnounce(ports, run.id, ended('cap_reached', 'before_read', { ...free, endReason: 'budget' }))).status };
            await updateAndAnnounce(ports, run.id, { resumeAt: fits.paused, endReason: 'budget' });
            return null;
          }
        }
        return { done: false as const, run: await updateAndAnnounce(ports, run.id, {
          status: 'reading', ...(run.resumeAt || run.endReason ? { resumeAt: null, endReason: null, planLimitResetsAt: null } : {}) }) };
      });
      if (!claimed) return 'skipped';
      if (claimed.done) return claimed.status;
      const run = claimed.run;

      // The owner's own signed-in CLI of this run (the vendor its consent named), in their own slot: never
      // chosen by a request.
      // A key run (#1441): pi, in the owner's own place, made when they have none yet.
      const located = runtime ? await runtime.target(run.ownerUserId, key ? 'pi' : run.provider === 'openai' ? 'codex' : 'claude_code').catch(() => ({ ok: false as const, reason: 'unavailable' as const })) : null;
      if (!located?.ok) {
        const signIn = located?.reason === 'sign_in_again';
        return finish(run.id, 'reading', () => ended('unavailable', 'before_dispatch', { ...free, ...(signIn ? { endReason: 'sign_in_again' as const } : {}) }));
      }
      const target = located.target;

      const ready = await uow.run(async (ports) => {
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'reading') return { done: true as const, outcome: (current?.status ?? 'skipped') as RuntimeRunOutcome };
        const end = async (changes: RunChanges) => ({ done: true as const, outcome: (await updateAndAnnounce(ports, run.id, changes)).status as RuntimeRunOutcome });
        if (current.stopRequestedAt) {
          // F-029: a stop request the turn-off sweep made says so.
          return end(ended((await spaceSwitchAllows(ports, current, false)) ? 'stopped' : 'ai_off', 'before_dispatch', free));
        }
        const refusal = await checked(ports, current, 'before_dispatch', true);
        if (refusal) return end(ended(refusal, 'before_dispatch', free));
        await updateAndAnnounce(ports, run.id, { status: 'dispatching', dispatchedAt: new Date() });
        return { done: false as const };
      });
      if (ready.done) return ready.outcome;

      // The run token, minted by the authorization server for this run only (F-027 A2). It never reaches a
      // log or the database; it travels to the slot in the run request and to the CLI in FLUX_RUN_TOKEN only.
      const grant = await tokens!.issue(run.id).catch(() => null);
      // A key run's model requests (#1441): their own token, which only the model gateway takes; the key stays in the worker.
      const modelToken = key && grant?.tools.length ? await key.gateway?.issue(run.id).catch(() => null) ?? null : null;
      if (!grant || !grant.tools.length || (key && !modelToken)) {
        await tokens!.close(run.id).catch(() => undefined);
        if (key && modelToken) await key.gateway?.close(run.id).catch(() => undefined);
        return finish(run.id, 'dispatching', () => ended('unavailable', 'before_dispatch', free));
      }
      /** What the gateway said of the run's requests at its end: unknown usage, and a refusal for the money or the run's standing. */
      let gatewayAccount: { unknown: number; stopped: 'budget' | 'ended' | null } | null = null;

      // `/ai` and a chat are shown to the asker while the CLI writes them (#1248); the run token is never shown, even half.
      // A key run's gateway token is never shown either (#1441): pi's own tools cannot read it, and an answer that held it still would not.
      const runSecrets = [grant.token, ...(modelToken ? [modelToken.token] : [])];
      const shown = live && isAsked(run) ? liveText(live, run, { secrets: runSecrets }) : undefined;
      // `budget` and `gateway`: the model gateway refused a request of a key run for the key's day (402) or the run's standing (403).
      type StopWhy = 'owner' | 'limit' | 'standing' | 'local_tool' | 'budget' | 'gateway';
      let stopWhy: StopWhy | null = null;
      let stopSent: Promise<void> | null = null;
      const stop = (why: StopWhy) => {
        stopWhy ??= why;
        // Once the run is to stop, the asker is sent no more of its words (#1248): not through the CLI's grace, and none after a refusal.
        shown?.abandon();
        stopSent ??= (async () => {
          const answer = await runtime!.stop(target, run.id).catch(() => 'failed' as const);
          // Requested and acknowledged are separate states (F-022 "Stop").
          if (answer === 'stopping') await uow.run(async (ports) => {
            const current = await ports.runs.findRun(run.id, { lock: true });
            if (current?.status === 'dispatching' && !current.stopAcknowledgedAt) await updateAndAnnounce(ports, run.id, { stopAcknowledgedAt: new Date() });
          }).catch(() => undefined);
        })();
      };
      // The CLI searches with its own web search while the operator's web switch is on (#1065, C-29, RT-5): Claude Code's WebSearch,
      // Codex's web search on OpenAI's cached index. pi has no web search of its own (#1441).
      const webSearch = runtime!.webSearch === true && !key;
      // The CLI's searches are written in the order it wrote them (C-30): the start with its query, then its results and, for Codex, its
      // queries. A failed write only leaves the search unlisted.
      let recorded: Promise<void> = Promise.resolve();
      const record = (step: (ports: PersonalRunPorts) => Promise<void>) => { recorded = recorded.then(() => uow.run(step)).catch(() => undefined); };
      const searchRows = new Map<number, string>();
      let searched = false;
      const onEvent = (event: PersonalRuntimeEvent) => {
        if (event.kind === 'init') { if (localToolInInit(event, grant.tools, webSearch)) stop('local_tool'); return; }
        if (event.kind === 'text') { shown?.turn(event.turn); shown?.push(event.text); return; }
        if (event.kind === 'search' || event.kind === 'found') {
          if (!webSearch) return;
          searched = true;
          if (event.kind === 'search') {
            const query = boundedWebSearch({ queries: [event.query], results: [], cited: [] }).queries[0] ?? '';
            record(async (ports) => { searchRows.set(event.n, await ports.runs.startWebSearch(run.id, query)); });
          } else {
            const { results, queries } = boundedWebSearch({ queries: event.queries ?? [], results: event.results, cited: [] });
            record(async (ports) => {
              const id = searchRows.get(event.n);
              if (id) await ports.runs.settleWebSearch(id, results, queries); else await ports.runs.addWebSearch(run.id, { queries, results, cited: [] });
            });
          }
          return;
        }
        shown?.step(event.name);
        // Owner-only progress: one more Flux tool call (O-008 §4; the audience is the owner alone).
        void uow.run((ports) => ports.events.record({ kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id,
          { status: 'dispatching', step: 'tool', tool: event.name })).catch(() => undefined);
      };
      const stopWatching = watch(run, { stop });
      // The gateway's refusal stops pi at once (#1441 review): pi does not retry it, and nothing waits for pi to give up on its own.
      const stopGatewayWatch = key?.gateway?.watch?.(run.id, (reason) => stop(reason === 'budget' ? 'budget' : 'gateway')) ?? (() => undefined);
      let end: PersonalRuntimeEnd;
      try {
        // The model is the one recorded when the request was sent (F-027 AST-11), never the owner's current choice.
        const model = key ? run.model : runtimeModelFlag(run.model);
        const read = await uow.run((ports) => runtimeContext(ports, run))
          .catch(async () => unreadContext(run, await uow.run((ports) => ports.runs.agentBrief(run.agentId)).catch(() => null)));
        // One brief for every place and both engines (#1064): the same text an API-key run gets, on standard input.
        const briefed: BriefInput = {
          engine: 'runtime', kind: run.kind, tools: grant.tools, ...read.facts, now: new Date(now()), agent: read.brief,
          prompt: grant.context ? `${run.prompt}\n${grant.context}` : run.prompt, requestedAt: run.createdAt, sources: read.sources, leftOut: read.leftOut,
          turns: read.turns, earlier: null, thought: run.targetSketchId && run.targetThoughtId ? { sketchId: run.targetSketchId, thoughtId: run.targetThoughtId } : null,
          webSearch,
        };
        const prompt = runtimeBrief(briefed);
        // What people, the company and its tools wrote in what the CLI is given is private Flux text the run read (#1065, #1136, C-30): a web
        // address may not carry it. Flux's own words in the brief are not private.
        const kept = await keepPrivateText(briefPrivateText(briefed));
        await uow.run((ports) => ports.runs.addPrivateText(run.id, kept));
        end = await runtime!.run(target, { runId: run.id, prompt, runToken: grant.token, tools: grant.tools, caps, ...(model ? { model } : {}),
          ...(webSearch ? { webSearch: true as const } : {}),
          ...(key ? { key: { provider: run.provider, pictures: aiModelSeesPictures(run.provider, run.model, 'server'), modelToken: modelToken!.token } } : {}) }, onEvent);
      } catch {
        // The stream to the slot broke: whether the CLI changed anything is unknown, and it is never rerun.
        end = { kind: 'ended', reason: 'unknown' };
      } finally {
        stopWatching();
        stopGatewayWatch();
        await shown?.close();
        await tokens!.close(run.id).catch(() => undefined);
        if (key) gatewayAccount = await key.gateway!.close(run.id).catch(() => ({ unknown: 1, stopped: null }));
      }
      // The gateway refused a request for the key's day (402): Flux stopped pi there, and the run ends "budget" (its calm end with the
      // key's day, as a key run of the worker's loop), whatever pi made of the refusal or of the stop. An owner's stop says stopped.
      if ((gatewayAccount?.stopped === 'budget' || stopWhy === 'budget') && end.kind === 'ended' && stopWhy !== 'owner') end = { kind: 'ended', reason: 'budget' };
      await stopSent;
      // Every search the CLI reported is written before the run's end is.
      await recorded;
      await hooks.afterDispatch?.(run);
      // The answer as it will be committed, worked out before the commit's transaction (#1156): cleaning reads and checks the run's kept
      // text, and that transaction holds the space's task lock. AIM-3 "Committed answer": token patterns and the exact run token become
      // "[removed: looked like a secret]"; then its final text is cleaned (#1143, #1149, C-30): after its schedule block is taken out (and the
      // schedule's instruction cleaned), before Flux lists its sources; the `<ask>` question decoded and cleaned.
      const prepare = async (text: string) => {
        const redacted = redactSecrets(text, runSecrets);
        const cleaner = answerCleaner(() => uow.run((ports) => ports.runs.privateTexts(run.id)));
        const searches = await uow.run((ports) => ports.runs.webSearches(run.id));
        // Claude Code and Codex are given no source to cite (#1222): every mark in their answer is the model's own and is taken out.
        return { redacted, prepared: await preparedAnswer(withoutInventedMarks(redacted.text), cleaner, searches.cited) };
      };
      const answer = end.kind === 'answer' && Buffer.byteLength(end.text, 'utf8') <= caps.maxAnswerBytes ? await prepare(end.text) : null;
      // The words the CLI had written when its owner stopped it (#1248), cleaned the same way; a `<schedule>` or `<ask>` block, whole or
      // begun, and what follows it are left out, so a stopped answer prepares and asks nothing.
      // A stop that lands as the answer completes keeps that answer, the same way.
      const all = end.kind === 'answer' ? end.text : shown ? shown.written : '';
      const cut = all.search(/<(?:schedule|ask)\b/);
      const written = cut >= 0 ? all.slice(0, cut) : all;
      const kept = !shown ? null : answer && cut < 0 ? answer
        : written.trim() && Buffer.byteLength(written, 'utf8') <= caps.maxAnswerBytes ? await prepare(written) : null;

      return uow.run(async (ports) => {
        const located = await ports.runs.findRun(run.id);
        if (!located || located.status !== 'dispatching') return 'skipped';
        const refusal = await checked(ports, located, 'before_commit', true);
        const fence = !refusal && end.kind === 'answer' ? await ports.runs.prepareTaskUse(located.projectId, located.conversationId) : null;
        const current = await ports.runs.findRun(run.id, { lock: true });
        if (!current || current.status !== 'dispatching') return 'skipped';
        const save = async (changes: RunChanges) => (await updateAndAnnounce(ports, run.id, changes)).status;
        // What the run used: a plan's is unknown to Flux; a key run's is what the model gateway charged on its row (#1441).
        const spent = key ? keySettled(current, (gatewayAccount?.unknown ?? 0) > 0) : used;
        // F-029: a run stopped because AI was turned off says so; nothing it produced is posted.
        if (refusal === 'ai_off') return save(ended('ai_off', 'before_commit', spent));
        if (current.stopRequestedAt) {
          // Stopped while it wrote (#1248): the words so far stay as its answer, marked stopped, only while the owner still stands where the
          // run was: a refusal stores nothing.
          if (kept && kept.prepared.text.trim() && !refusal) {
            const words = await answerWithWebSources(ports, run, kept.prepared.text, kept.prepared.cited);
            return save(ended('stopped', 'before_commit', { ...spent, answerBody: words.trim(), answerTruncated: false, answerSources: [], answerRedacted: kept.redacted.changed, committedAt: new Date() }));
          }
          return save(ended('stopped', 'before_commit', spent));
        }
        if (stopWhy === 'local_tool' || (end.kind === 'ended' && end.reason === 'local_tool')) return save(ended('unavailable', null, { ...spent, endReason: 'local_tool' }));
        if (current.mcpLimit) return save(ended('cap_reached', 'before_commit', { ...spent, endReason: 'mcp_results_too_large' }));
        // Access, pause, removal or a revoked connection after the start: nothing is posted.
        if (refusal) return save(ended(refusal, 'before_commit', spent));
        // The gateway found the run may no longer use the key (403) for a reason the commit's checks no longer see (the key's model lost
        // its price): the key is unavailable to the run, not a crash.
        if (stopWhy === 'gateway' && end.kind === 'ended' && end.reason !== 'budget') return save(ended('unavailable', null, spent));
        if (end.kind === 'ended') {
          const status = await save(endChanges(end.reason, end.planResetsAt, spent));
          if (end.reason === 'plan_limit') await pauseUntilReset(ports, current, end.planResetsAt, now());
          return status;
        }
        if (!answer) return save(ended('cap_reached', null, { ...spent, endReason: 'answer_too_large' }));
        const { redacted, prepared } = answer;
        const text = await answerWithSchedule(ports, run, prepared);
        // Claude Code hands Flux no citations (#1065, C-30): the addresses its answer names count as cited, listed when its search returned
        // them; those of the cleaned answer, so an address left out is never listed.
        if (searched) await ports.runs.addWebSearch(run.id, boundedWebSearch({ queries: [], results: [], cited: addressesIn(text, WEB_SEARCH_BOUNDS.cited) }));
        const words = await answerWithWebSources(ports, run, text, prepared.cited);
        const status = await save(ended('completed', null, {
          ...spent, answerBody: words.trim() || '(No answer text.)', answerTruncated: false, answerSources: [], answerRedacted: redacted.changed,
          committedAt: new Date(),
        }));
        await fence?.mark();
        return status;
      });
    },
  };
}
