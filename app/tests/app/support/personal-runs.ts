import { tablePrice, type AiPrice, type AiProviderKind } from '@flux/contracts';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup, PersonalRunQueue,
} from '@flux/core';
import type { DbExecutor } from '@flux/db';

// TEST SUPPORT ONLY (#68). In-memory stand-ins for the owner's key connection (#124), the provider
// adapter and the dispatch queue. They are never part of a production composition: the server and
// worker compose `noPersonalConnections` and `unavailablePersonalCompute`. Nothing here calls a
// model, so no test using them counts as a provider, billing or compatibility pass.

const SONNET = tablePrice('anthropic', 'claude-sonnet-5')!;
/** The table price of the default fake connection's model: $2/M input, $10/M output (checked 2026-10-02). */
export const FAKE_PRICE: AiPrice = { inputMicrosPerMTok: SONNET.inputMicrosPerMTok, outputMicrosPerMTok: SONNET.outputMicrosPerMTok, source: 'table', checkedOn: SONNET.checkedOn };

/**
 * Each owner's connections, newest last. `keyRef` stands in for #124's key reference; no key exists.
 * Like the production lookup it returns exactly the named connection, or without a name the newest.
 */
export class FakeConnections implements PersonalConnectionLookup {
  readonly byOwner = new Map<string, PersonalConnection[]>();
  resolved: string[] = [];

  /** Adds a connection (or replaces the one with that id); the owner's others stay. */
  connect(ownerUserId: string, id: string, model: { provider?: AiProviderKind; model?: string; baseUrl?: string | null; price?: AiPrice | null } = {}): PersonalConnection {
    const connection: PersonalConnection = {
      id, ownerUserId, status: 'active', keyRef: `test-key-ref-${id}`,
      payer: { organization: `Payer org of ${ownerUserId}`, workspace: 'Default' },
      provider: model.provider ?? 'anthropic', model: model.model ?? 'claude-sonnet-5', baseUrl: model.baseUrl ?? null,
      price: model.price === undefined ? FAKE_PRICE : model.price,
    };
    this.byOwner.set(ownerUserId, [...(this.byOwner.get(ownerUserId) ?? []).filter((item) => item.id !== id), connection]);
    return connection;
  }

  /** Removes one of the owner's connections, or all of them. */
  disconnect(ownerUserId: string, id?: string) {
    if (id === undefined) this.byOwner.delete(ownerUserId);
    else this.byOwner.set(ownerUserId, (this.byOwner.get(ownerUserId) ?? []).filter((item) => item.id !== id));
  }

  async resolve(ownerUserId: string, connectionId?: string) {
    this.resolved.push(ownerUserId);
    const owned = this.byOwner.get(ownerUserId) ?? [];
    return (connectionId === undefined ? owned.at(-1) : owned.find((item) => item.id === connectionId)) ?? null;
  }
}

export type Responder = (request: PersonalComputeRequest, signal: AbortSignal) => Promise<PersonalComputeResult>;

/** Echoes its input by default, so a leaked token would show in the dispatched input and the answer. */
export const echo: Responder = async (request) => ({
  kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: Math.ceil(request.input.length / 4), outputTokens: 120 },
  text: `Fact: the conversation reports a low-light failure [S1]. Echo of what I was given:\n${request.input}`,
});

/** A fake provider that records every counted and dispatched request. */
export class FakeCompute implements PersonalCompute {
  enabled = true;
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
