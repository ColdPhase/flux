import { type AiPrice, type AiProviderKind, type AssistantModelPick } from '@flux/contracts';
import type {
  createPersonalRunUseCases, Principal, PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup, PersonalRunQueue,
} from '@flux/core';
import type { DbExecutor } from '@flux/db';

// TEST SUPPORT ONLY (#68). In-memory stand-ins for the owner's key connection (#124), the provider
// adapter and the dispatch queue. They are never part of a production composition: the server and
// worker compose `noPersonalConnections` and `unavailablePersonalCompute`. Nothing here calls a
// model, so no test using them counts as a provider, billing or compatibility pass.

/** The default fake connection's model at its list price: Claude Sonnet 5, $2/M input, $10/M output (Flux's price list of 2026-11-13). */
export const FAKE_PRICE: AiPrice = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'list', checkedOn: '2026-11-13' };

/**
 * Each owner's connections, newest last. `keyRef` stands in for #124's key reference; no key exists.
 * Like the production lookup it returns exactly the named connection, or without a name the newest.
 */
export class FakeConnections implements PersonalConnectionLookup {
  readonly byOwner = new Map<string, PersonalConnection[]>();
  resolved: string[] = [];

  private made = 0;

  /** Adds a connection (or replaces the one with that id); the owner's others stay. Its one daily budget defaults to $10 (#854). */
  connect(ownerUserId: string, id: string, model: { provider?: AiProviderKind; model?: string; baseUrl?: string | null; price?: AiPrice | null;
    dailyBudgetCents?: number; timeZone?: string; models?: PersonalConnection['models'] } = {}): PersonalConnection {
    const connection: PersonalConnection = {
      id, ownerUserId, status: 'active', keyRef: `test-key-ref-${id}`, name: `Key ${id.slice(0, 8)}`,
      dailyBudgetCents: model.dailyBudgetCents ?? 1_000, timeZone: model.timeZone ?? 'UTC', createdAt: new Date(Date.UTC(2026, 0, 1) + this.made++ * 1000),
      provider: model.provider ?? 'anthropic', model: model.model ?? 'claude-sonnet-5', baseUrl: model.baseUrl ?? null,
      price: model.price === undefined ? FAKE_PRICE : model.price,
      ...(model.models ? { models: model.models } : {}),
    };
    this.byOwner.set(ownerUserId, [...(this.byOwner.get(ownerUserId) ?? []).filter((item) => item.id !== id), connection]);
    return connection;
  }

  /** Removes one of the owner's connections, or all of them. */
  disconnect(ownerUserId: string, id?: string) {
    if (id === undefined) this.byOwner.delete(ownerUserId);
    else this.byOwner.set(ownerUserId, (this.byOwner.get(ownerUserId) ?? []).filter((item) => item.id !== id));
  }

  /** The owner's newest connection, as a model pick of its own model (what the old "newest connection" turn-on used). */
  latest(ownerUserId: string): { connection: string; model: string } {
    const newest = (this.byOwner.get(ownerUserId) ?? []).at(-1);
    if (!newest) throw new Error('No fake connection for this owner');
    return { connection: newest.id, model: newest.model };
  }

  async list(ownerUserId: string) {
    return [...(this.byOwner.get(ownerUserId) ?? [])];
  }

  async resolve(ownerUserId: string, connectionId?: string) {
    this.resolved.push(ownerUserId);
    const owned = this.byOwner.get(ownerUserId) ?? [];
    return (connectionId === undefined ? owned.at(-1) : owned.find((item) => item.id === connectionId)) ?? null;
  }
}

export type Responder = (request: PersonalComputeRequest, signal: AbortSignal) => Promise<PersonalComputeResult>;

/**
 * Echoes its input by default, so a leaked token would show in the dispatched input and the answer. It cites every source it was given
 * (`ref="S<n>"` in the brief, #1064), as a model that used them all would.
 */
export const echo: Responder = async (request) => ({
  kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: Math.ceil(request.input.length / 4), outputTokens: 120 },
  text: `Fact: the conversation reports a low-light failure [S1]. Drawn from ${[...request.input.matchAll(/ ref="(S\d+)"/g)].map((match) => `[${match[1]}]`).join(' ') || 'nothing'}. Echo of what I was given:\n${request.input}`,
});

/** A fake provider that records every counted and dispatched request. */
export class FakeCompute implements PersonalCompute {
  enabled = true;
  /** The operator's web switch as the worker sees it (#954): a run with tools is then offered its provider's own search. Off unless a test says. */
  webSearch?: boolean;
  counted: PersonalComputeRequest[] = [];
  dispatched: PersonalComputeRequest[] = [];
  respond: Responder = echo;

  /** Runs after each recorded count request, e.g. to change access between two counts. */
  onCount: ((request: PersonalComputeRequest) => Promise<void>) | null = null;
  count: (request: PersonalComputeRequest) => number = (request) => Math.ceil(request.input.length / 4);

  async countInputTokens(request: PersonalComputeRequest) {
    this.counted.push(request);
    const tokens = this.count(request);
    await this.onCount?.(request);
    return tokens;
  }

  async dispatch(request: PersonalComputeRequest, signal: AbortSignal) {
    this.dispatched.push(request);
    return this.respond(request, signal);
  }
}

/** Records queued run ids instead of sending pg-boss jobs, so the real worker never races a test. */
export class FakeQueue {
  readonly runIds: string[] = [];
  readonly factory: (tx: DbExecutor) => PersonalRunQueue = () => ({ enqueue: async (runId) => { this.runIds.push(runId); } });
}

type ModelUseCases = Pick<ReturnType<typeof createPersonalRunUseCases>, 'listAgents' | 'updateAgent' | 'model'>;

/**
 * Moves an agent to a model of one of its owner's connections the way its page does (`PATCH /api/v1/my-agents/:id`, `updateAgent`):
 * the owner's first agent unless `agentId` names another. Resolves with what the owner may choose afterwards, as `runs.model` says it.
 */
export async function chooseModel(runs: ModelUseCases, principal: Principal, pick: AssistantModelPick, agentId?: string) {
  const id = agentId ?? (await runs.listAgents(principal))[0]?.id;
  if (!id) throw new Error('The owner has no agent to choose a model for');
  await runs.updateAgent(principal, id, { connection: pick.connection, model: pick.model });
  return runs.model(principal);
}
