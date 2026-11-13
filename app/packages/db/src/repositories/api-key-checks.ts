import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

const checks = schema.apiKeyChecks;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'insert'>;

/** What one check of a model of a key found (#1441, RT-1 rule 2). */
export interface ApiKeyCheck { connectionId: string; model: string; callsTools: boolean; chargedMicros: number }

/**
 * The checks that a model of an API key calls tools (RT-1 rule 2, #1441). One row is one request sent to the provider on that model with
 * the one tool `ping`: whether the model called it, and what the request cost, which `apiKeySpendToday` counts on the key's day (CA-3). A key
 * and model with a row that called the tool are not checked again. The API writes them on a handle of its own, never inside the transaction
 * that waited for the provider, so a refused model's cost is kept although the change it was asked for is not.
 */
export function apiKeyCheckRows(db: Database) {
  return {
    /** Whether this model of this key called `ping` once. */
    async passed(connectionId: string, model: string): Promise<boolean> {
      const [row] = await db.select({ id: checks.id }).from(checks)
        .where(and(eq(checks.connectionId, connectionId), eq(checks.model, model), eq(checks.callsTools, true))).limit(1);
      return Boolean(row);
    },
    async record(check: ApiKeyCheck): Promise<void> {
      await db.insert(checks).values({ id: randomUUID(), connectionId: check.connectionId, model: check.model, callsTools: check.callsTools, chargedMicros: check.chargedMicros });
    },
  };
}
