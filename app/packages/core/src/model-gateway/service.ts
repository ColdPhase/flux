import { createHash, randomBytes } from 'node:crypto';
import type { AiProviderKind } from '@flux/contracts';
import type { PersonalConnection, PersonalConnectionLookup, PersonalRunPorts, PersonalRunUnitOfWork } from '../personal-runs/ports.js';
import { connectionOnModel } from '../personal-runs/model.js';
import { spaceSwitchAllows } from '../personal-runs/place.js';
import { centsToMicros } from '../personal-runs/validation.js';
import { admitGatewayRequest, type AdmittedRequest, type GatewayAdmissionLimits, type GatewayRequestFacts } from './admission.js';
import { gatewayChargeMicros, gatewayHoldMicros, type GatewayCharge } from './charge.js';
import type { GatewayUsage } from './usage.js';

// The model gateway's use cases (#1441, docs/product/ai-modes.md "The model gateway"; CA-3, CA-4). A run on an API key in the runtime
// holds a gateway token, never the key. For each request: the token names a run that is working (the run row's own token hash, not
// expired, not closed), the run is still allowed (not stopped, AI on in its space at its epoch, its connection active and of this
// provider), the request is admitted (its model, its bounds), and the most it can cost is held on the run against what is left of the
// key's daily budget, under the owner's lane lock with the run row locked, as a server run reserves (#854). After the answer, what the
// provider reported is charged and the rest of the hold released. The key is opened by the caller (the worker) only after `open`.

export type GatewayRefusalCode = 'flux_token_invalid' | 'flux_budget_exhausted' | 'flux_run_ended' | 'flux_run_busy' | 'flux_request_refused';
export interface GatewayRefusal { status: 400 | 401 | 402 | 403 | 429; code: GatewayRefusalCode; message: string }

export interface GatewayTicket {
  runId: string;
  provider: AiProviderKind;
  /** The run's connection on the run's model, with its price; its `keyRef` is what the worker opens. */
  connection: PersonalConnection;
  request: AdmittedRequest;
  holdMicros: number;
  /** Released by `settle` or `release`. */
  readonly slot: string;
}

/** What a run's requests through the gateway came to, for the run's engine at its end. */
export interface GatewayAccount {
  requests: number;
  chargedMicros: number;
  /** Requests whose usage could not be used: each was charged all it held. */
  unknown: number;
  /** Why a request was refused for the run's money or standing: the run's engine stops the run (#1441). */
  stopped: 'budget' | 'ended' | null;
}

export interface ModelGatewayDeps {
  uow: PersonalRunUnitOfWork;
  connections: PersonalConnectionLookup;
  limits: GatewayAdmissionLimits & { concurrentPerRun: number };
  /** How long a token works at most: the run's own clock and some minutes (`RUN_TOKEN_LIMITS.lifetimeSeconds`). */
  tokenLifetimeMs: number;
  now?: () => number;
  /** Told when a run's request was refused for its money or its standing, so its engine stops it instead of the harness retrying. */
  onStop?: (runId: string, reason: 'budget' | 'ended') => void;
}

export const MODEL_GATEWAY_TOKEN_PATTERN = /^flux_mg_[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const refusals = {
  token: { status: 401, code: 'flux_token_invalid', message: 'This gateway token is not valid: unknown, expired or closed' },
  ended: { status: 403, code: 'flux_run_ended', message: 'This run has ended or may no longer use the key; stop' },
  budget: { status: 402, code: 'flux_budget_exhausted', message: "The key's daily budget cannot hold this request; stop" },
  busy: { status: 429, code: 'flux_run_busy', message: 'This run already has as many requests in flight as it may; wait for one to finish' },
} as const satisfies Record<string, GatewayRefusal>;

function gatewayRows(ports: PersonalRunPorts) {
  const { gatewayRunId, armGateway, closeGateway } = ports.runs;
  if (!gatewayRunId || !armGateway || !closeGateway) throw new Error('The run repository has no model gateway rows');
  return { gatewayRunId: gatewayRunId.bind(ports.runs), armGateway: armGateway.bind(ports.runs), closeGateway: closeGateway.bind(ports.runs) };
}

export function createModelGateway({ uow, connections, limits, tokenLifetimeMs, now = Date.now, onStop }: ModelGatewayDeps) {
  /** Requests in flight per token hash (one token per run). */
  const inFlight = new Map<string, number>();
  const accounts = new Map<string, GatewayAccount>();
  const accountOf = (runId: string) => {
    let account = accounts.get(runId);
    if (!account) { account = { requests: 0, chargedMicros: 0, unknown: 0, stopped: null }; accounts.set(runId, account); }
    return account;
  };
  const release = (slot: string) => {
    const left = (inFlight.get(slot) ?? 1) - 1;
    if (left <= 0) inFlight.delete(slot); else inFlight.set(slot, left);
  };
  const stop = (runId: string, reason: 'budget' | 'ended') => {
    const account = accountOf(runId);
    if (account.stopped) return;
    account.stopped = reason;
    try { onStop?.(runId, reason); } catch { /* the run's own checks still stop it */ }
  };

  const gateway = {
    /**
     * A token for a run on an API key in the runtime that is working: its hash and expiry are stored on the run, the token itself is
     * returned once and kept nowhere. A new one replaces the run's earlier one. Null for any other run.
     */
    async issue(runId: string): Promise<{ token: string; expiresAt: Date } | null> {
      const token = `flux_mg_${randomBytes(32).toString('base64url')}`;
      const expiresAt = new Date(now() + tokenLifetimeMs);
      const armed = await uow.run(async (ports) => {
        const run = await ports.runs.findRun(runId, { lock: true });
        if (!run || (run.status !== 'reading' && run.status !== 'dispatching') || run.stopRequestedAt || run.engine !== 'runtime' || !run.connectionId) return false;
        return gatewayRows(ports).armGateway(run.id, sha256(token), expiresAt);
      });
      if (!armed) return null;
      accounts.set(runId, { requests: 0, chargedMicros: 0, unknown: 0, stopped: null });
      return { token, expiresAt };
    },

    /** Ends the run's token (its requests in flight still settle) and gives what its requests came to. */
    async close(runId: string): Promise<GatewayAccount> {
      await uow.run((ports) => gatewayRows(ports).closeGateway(runId));
      const account = accountOf(runId);
      accounts.delete(runId);
      return { ...account };
    },

    /** What the run's requests came to so far. */
    account: (runId: string): GatewayAccount => ({ ...accountOf(runId) }),

    /** Checks a request and holds its money; the caller must `settle` (or `release`) the ticket. */
    async open(token: string, facts: GatewayRequestFacts, raw: Buffer): Promise<{ ok: true; ticket: GatewayTicket } | { ok: false; refusal: GatewayRefusal }> {
      if (!MODEL_GATEWAY_TOKEN_PATTERN.test(token)) return { ok: false, refusal: refusals.token };
      const hash = sha256(token);
      if ((inFlight.get(hash) ?? 0) >= limits.concurrentPerRun) return { ok: false, refusal: refusals.busy };
      inFlight.set(hash, (inFlight.get(hash) ?? 0) + 1);
      let outcome: { ok: true; ticket: GatewayTicket } | { ok: false; refusal: GatewayRefusal; stop?: { runId: string; reason: 'budget' | 'ended' } };
      try {
        outcome = await uow.run(async (ports) => {
          const runId = await gatewayRows(ports).gatewayRunId(hash);
          if (!runId) return { ok: false as const, refusal: refusals.token };
          const run = await ports.runs.findRun(runId, { lock: true });
          const ended = { ok: false as const, refusal: refusals.ended, stop: { runId, reason: 'ended' as const } };
          if (!run || run.status !== 'dispatching' || run.stopRequestedAt || run.engine !== 'runtime' || !run.connectionId) return ended;
          // The owner's lane, as a server run reserves on the key (#854): no other reservation of the owner's interleaves with this one.
          await ports.runs.lockLane(run.ownerUserId);
          if (!(await spaceSwitchAllows(ports, run, true))) return ended;
          const named = await connections.resolve(run.ownerUserId, run.connectionId);
          if (!named || named.status !== 'active' || named.ownerUserId !== run.ownerUserId || named.id !== run.connectionId) return ended;
          if (named.provider !== facts.provider) return { ok: false as const, refusal: { status: 400, code: 'flux_request_refused', message: `This run's key is for ${named.provider}` } };
          const connection = connectionOnModel(named, run.model);
          if (!connection?.price) return ended;
          const admission = admitGatewayRequest(facts, raw, run.model, limits);
          if (!admission.ok) return { ok: false as const, refusal: { status: 400, code: 'flux_request_refused', message: admission.message } };
          const holdMicros = gatewayHoldMicros(connection.price, facts.provider, admission.request);
          const spend = await ports.runs.keySpend(named, run.id);
          if (!spend) return ended;
          // Everything else on the key today, and this run's own hold (what it was charged and what its requests in flight hold).
          const left = centsToMicros(spend.budgetCents) - spend.chargedMicros - spend.reservedMicros;
          if (run.reservedMicros + holdMicros > left || run.reservedMicros + holdMicros > 2 ** 31 - 1) return { ok: false as const, refusal: refusals.budget, stop: { runId, reason: 'budget' as const } };
          // The first hold of the run counts on the day it is made (#854), like a server run's reservation at its turn.
          await ports.runs.updateRun(run.id, { reservedMicros: run.reservedMicros + holdMicros, costState: 'reserved', ...(run.reservedMicros === 0 ? { reservedAt: new Date(now()) } : {}) });
          return { ok: true as const, ticket: { runId: run.id, provider: facts.provider, connection, request: admission.request, holdMicros, slot: hash } };
        });
      } catch (error) {
        release(hash);
        throw error;
      }
      if (!outcome.ok) {
        release(hash);
        if (outcome.stop) stop(outcome.stop.runId, outcome.stop.reason);
        return { ok: false, refusal: outcome.refusal };
      }
      return outcome;
    },

    /**
     * Charges a request: its reported usage (`null`: none that can be used, so all it held), or nothing for an answer the provider
     * refused as a whole (`not_billed`: an HTTP error status, or nothing was sent). The rest of the hold is released.
     */
    async settle(ticket: GatewayTicket, usage: GatewayUsage | null | 'not_billed'): Promise<GatewayCharge> {
      const charge: GatewayCharge = usage === 'not_billed' ? { micros: 0, known: true }
        : gatewayChargeMicros(ticket.connection.price!, ticket.provider, ticket.request, ticket.holdMicros, usage);
      try {
        await uow.run(async (ports) => {
          const run = await ports.runs.findRun(ticket.runId, { lock: true });
          if (!run) return;
          const counted = usage !== 'not_billed' && usage !== null && charge.known;
          await ports.runs.updateRun(run.id, {
            chargedMicros: run.chargedMicros + charge.micros,
            reservedMicros: Math.max(run.chargedMicros + charge.micros, run.reservedMicros - ticket.holdMicros + charge.micros),
            ...(counted ? { inputTokens: (run.inputTokens ?? 0) + usage.inputTokens, outputTokens: (run.outputTokens ?? 0) + usage.outputTokens } : {}),
          });
        });
      } finally {
        release(ticket.slot);
      }
      const account = accountOf(ticket.runId);
      if (usage !== 'not_billed') account.requests += 1;
      account.chargedMicros += charge.micros;
      if (!charge.known) account.unknown += 1;
      return charge;
    },

    /** Gives up a ticket whose request was never sent, with nothing charged. */
    release: (ticket: GatewayTicket): Promise<GatewayCharge> => gateway.settle(ticket, 'not_billed'),
  };
  return gateway;
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
