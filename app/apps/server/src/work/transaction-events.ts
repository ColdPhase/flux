import { recordEvents, type EventIntent, type Transaction } from '@flux/core';
import { withTaskUseErrors } from './task-use-errors.js';

function freezeNested(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeNested(child);
    Object.freeze(value);
  }
}

/** One guarded event preparation lifetime inside an already-open transaction. */
export function transactionEventSession(tx: Transaction) {
  const intents: EventIntent[] = [];
  let closed = false;
  let active = 0;
  let flushing: Promise<string[]> | undefined;
  return {
    async run<T>(action: () => Promise<T>): Promise<T> {
      if (closed) throw new Error('Native event session is closed');
      active++;
      try { return await withTaskUseErrors(action); } finally { active--; }
    },
    async record(principal: EventIntent['principal'], workspaceId: string,
      kind: string, objectId: string, data: EventIntent['data']): Promise<void> {
      if (closed) throw new Error('Native event session is closed');
      const snapshot = structuredClone(data);
      freezeNested(snapshot);
      intents.push(Object.freeze({ principal: Object.freeze({ ...principal }),
        workspaceId, kind, objectId, data: snapshot }));
    },
    get eventIntents(): readonly EventIntent[] { return Object.freeze([...intents]); },
    flushEvents(): Promise<string[]> {
      if (flushing) return flushing;
      if (active) throw new Error('Await all native commands before flushing events');
      closed = true;
      flushing = recordEvents(tx, intents);
      return flushing;
    },
  };
}
export type TransactionEventSession = ReturnType<typeof transactionEventSession>;
