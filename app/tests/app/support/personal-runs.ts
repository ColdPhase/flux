import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalConnection, PersonalConnectionLookup, PersonalRunQueue,
} from '@flux/core';
import type { DbExecutor } from '@flux/db';

// TEST SUPPORT ONLY (#68). In-memory stand-ins for the owner's key connection (#124), the provider
// adapter and the dispatch queue. They are never part of a production composition: the server and
// worker compose `noPersonalConnections` and `unavailablePersonalCompute`. Nothing here calls a
// model, so no test using them counts as a provider, billing or compatibility pass.

/** Connections keyed by owner. `keyRef` stands in for #124's key reference; no key exists. */
export class FakeConnections implements PersonalConnectionLookup {
  readonly byOwner = new Map<string, PersonalConnection>();
  resolved: string[] = [];

  connect(ownerUserId: string, id: string): PersonalConnection {
    const connection: PersonalConnection = {
      id, ownerUserId, status: 'active', keyRef: `test-key-ref-${id}`,
      payer: { organization: `Payer org of ${ownerUserId}`, workspace: 'Default' },
    };
    this.byOwner.set(ownerUserId, connection);
    return connection;
  }

  disconnect(ownerUserId: string) {
    this.byOwner.delete(ownerUserId);
  }

  async resolve(ownerUserId: string) {
    this.resolved.push(ownerUserId);
    return this.byOwner.get(ownerUserId) ?? null;
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
