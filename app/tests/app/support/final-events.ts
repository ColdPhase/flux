import assert from 'node:assert/strict';
import { schema } from '@flux/db';
import type { Transaction } from '@flux/core';

/** Instruments the real executor, retaining PostgreSQL writes and policy queries. */
export function guardFinalEventPhase(tx: Transaction) {
  let started = false;
  const checked = new Proxy(tx, { get(target, property) {
    if (property === 'transaction') return () => { throw new Error('Native preparation uses the caller-owned transaction'); };
    if (['select', 'selectDistinct', 'update', 'delete', 'execute'].includes(String(property))) return (...args: unknown[]) => {
      assert.equal(started, false, 'no domain/policy operation after the first event insertion');
      return Reflect.apply(Reflect.get(target, property), target, args);
    };
    if (property === 'insert') return (table: unknown) => {
      if (table === schema.events) started = true;
      if (started) assert.ok(table === schema.events || table === schema.eventAudience,
        'only final events and their derived audience rows follow the first event');
      return Reflect.apply(target.insert, target, [table]);
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { tx: checked, get started() { return started; } };
}
