import { RUNTIME_RUN_LIMITS } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { JobRetryPolicy } from '../push/config.js';
import { isId } from '../work/validation.js';
import type {
  PersonalCompute, PersonalConnection, PersonalConnectionLookup, PersonalRunPorts, PersonalRunTokenIssuer, PersonalRunUnitOfWork, PersonalRuntime,
  RunLiveText, RunRecord,
} from './ports.js';
import { connectionOnModel } from './model.js';
import { placeAllows, spaceSwitchAllows } from './place.js';
import { createRuntimeRunProcessor, type KeyRunGateway, type RuntimeCaps } from './runtime-run.js';
import { reserveOnKey } from './service.js';
import { centsToMicros } from './validation.js';

// The worker side of a personal run (`personal-run.dispatch.v1`, O-008 §3–§5). The job payload is the run id only. Every agent runs in
// the agent runtime (#1441, RT-1, founder decision 2026-11-13): a plan in its vendor's CLI, an API key in pi, whose model requests go
// through Flux's model gateway (the key stays in the worker, and every request is metered against the key's daily budget, #854). The
// worker has no agent loop of its own. Before reading, before the run starts and inside the commit transaction the run is checked again:
// the owner's enablement (pause, removal), the owner's own connection, the agent (`agent.invoke`), the owner's current access to the
// place and, for a key, the key's daily budget. A run refused before it starts costs zero. A refusal at commit stores nothing: the answer
// is withheld. There is never another payer, connection or engine to fall back to.

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

/** Test seam after the run's engine ended, before the commit transaction. */
export interface PersonalRunHooks {
  afterDispatch?: (run: RunRecord) => Promise<void>;
}

export interface PersonalRunProcessorDeps {
  uow: PersonalRunUnitOfWork;
  connections: PersonalConnectionLookup;
  compute: PersonalCompute;
  /** How often a dispatching run checks for the owner's stop. */
  stopPollMs?: number;
  hooks?: PersonalRunHooks;
  now?: () => number;
  /**
   * The owner's own Claude Code in the agent runtime (F-022 AIM-3, #280) and the run token's minting
   * (F-027 A2). Without them a `runtime` run ends `unavailable` at zero cost.
   */
  runtime?: PersonalRuntime;
  tokens?: PersonalRunTokenIssuer;
  /** Test seam: lower runtime run caps (within the protocol's bounds); production uses RUNTIME_RUN_LIMITS. */
  runtimeCaps?: Partial<RuntimeCaps>;
  /** The asker's live view (#1248): the words of `/ai` and of a chat as they are written, and the current step. Without it nothing is sent. */
  live?: RunLiveText;
  /** Flux's model gateway (#1441): API-key runs in pi send their model requests through it. Without it such a run ends `unavailable`. */
  gateway?: KeyRunGateway;
}

type Stage = 'before_read' | 'before_dispatch' | 'before_commit';
type Refusal = Extract<RunRecord['status'], 'denied' | 'revoked' | 'unavailable' | 'cap_reached'> | 'ai_off';

/**
 * The owner's standing at one step. Null when the run may continue; otherwise the terminal
 * status. `lock` holds the rows the decision depends on until the unit of work commits.
 */
async function recheck(ports: PersonalRunPorts, connections: PersonalConnectionLookup, compute: PersonalCompute, run: RunRecord, stage: Stage, lock: boolean): Promise<{ refusal: Refusal } | { connection: PersonalConnection }> {
  // AG-10, first: AI on in the run's space, at the epoch the run was admitted under (policy row before the others).
  if (!(await spaceSwitchAllows(ports, run, lock))) return { refusal: 'ai_off' };
  if (!(await ports.runs.enablement(run.ownerUserId, { lock, agentId: run.agentId }))) return { refusal: 'revoked' };
  const owner: Principal = { kind: 'human', id: run.ownerUserId };
  if (!(await ports.access.canInvoke(owner, run.agentId, { lock }))) return { refusal: 'revoked' };
  // A run that holds a run token acts as the owner's assistant connection (F-027 AST-3): revoking it ends the run.
  if (run.runTokenJti && ports.runs.assistantConnectionLive && !(await ports.runs.assistantConnectionLive(run.ownerUserId, run.agentId)))
    return { refusal: 'revoked' };
  if (!compute.enabled) return { refusal: 'unavailable' };
  // Exactly the connection the run was started on (PROV-1), never the owner's newest or another. Choosing another model
  // for the next request does not touch a request already sent.
  const connection = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== run.ownerUserId
    || connection.id !== run.connectionId) return { refusal: 'unavailable' };
  // The sources are what the owner can read in this place, as the agent;
  // the answer is posted to the place, so its owner must still be able to write there.
  if (!(await placeAllows(ports, run, lock))) return { refusal: 'denied' };
  if (stage === 'before_dispatch') {
    // The key's one daily budget (#854): what the rest of the day's work holds, and this run's own reservation.
    const spend = await ports.runs.keySpend(connection, run.id);
    if (!spend || spend.chargedMicros + spend.reservedMicros + run.reservedMicros > centsToMicros(spend.budgetCents)) return { refusal: 'cap_reached' };
  }
  return { connection };
}

/**
 * The production provider until the operator switch and a real connection lookup exist (see
 * docs/development/personal-runs.md): switched off, so every queued run ends `unavailable` at zero cost.
 */
export const unavailablePersonalCompute: PersonalCompute = {
  enabled: false,
  dispatch: async () => ({ kind: 'failed', reason: 'provider_error', billed: 'none' }),
};

export function createPersonalRunProcessor({ uow, connections, compute, stopPollMs = 250, hooks = {}, now = Date.now, runtime, tokens, runtimeCaps, live,
  gateway }: PersonalRunProcessorDeps) {
  const runtimeRuns = createRuntimeRunProcessor({ uow, runtime, tokens, stopPollMs, hooks, now, ...(runtimeCaps ? { caps: runtimeCaps } : {}), ...(live ? { live } : {}) });
  /**
   * API-key agents in pi (#1441, RT-1): every key run goes to the runtime (`pi` in FLUX_AGENT_RUNTIME; without it the run ends
   * `unavailable`), under the key's own standing checks; Flux's model gateway holds the key and meters each request.
   */
  const keyRuns = createRuntimeRunProcessor({ uow, runtime, tokens, stopPollMs, hooks, now, ...(runtimeCaps ? { caps: runtimeCaps } : {}), ...(live ? { live } : {}),
    key: {
      gateway,
      async check(ports, run, stage, lock) {
        const checked = await recheck(ports, connections, compute, run, stage, lock);
        return 'refusal' in checked ? checked.refusal : null;
      },
      async fits(ports, run) {
        const named = run.connectionId ? await connections.resolve(run.ownerUserId, run.connectionId) : null;
        const onModel = named ? connectionOnModel(named, run.model) : null;
        if (!onModel) return 'unavailable';
        // One request with tools must fit in what is left of the key's day; nothing is held for the run (`admit`): the gateway reserves each.
        const held = await reserveOnKey(ports, onModel, true, 1, run.id, true);
        return 'paused' in held ? { paused: held.paused } : 'ok';
      },
    } });
  return {
    /** One dispatch job. Returns the run's final status, or `skipped` for a run that is not queued. */
    async process(runId: unknown): Promise<PersonalRunOutcome> {
      if (!isId(runId)) return 'skipped';
      const id = runId.toLowerCase();
      // A run on the owner's own Claude Code goes to the agent runtime (F-022 AIM-3 "Run", #280).
      const engine = (await uow.run((ports) => ports.runs.findRun(id)))?.engine;
      if (engine === 'runtime') return runtimeRuns.process(id);
      // Every API key runs in pi in the agent runtime (#1441, RT-1): the worker has no agent loop of its own.
      return keyRuns.process(id);
    },
  };
}
