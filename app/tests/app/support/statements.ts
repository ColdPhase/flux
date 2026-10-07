import { after } from 'node:test';
import type pg from 'pg';
import { createDatabase } from '@flux/db';
import { connectionString, pool as observer } from './db.js';

/** One statement as a client sent it. */
export interface SentStatement {
  text: string;
  values: unknown[];
}

/**
 * A Flux database handle (#298) that records every statement its clients send, BEGIN and COMMIT
 * included, so a test can assert how many round trips a use case costs and explain the exact SQL
 * it ran. It is `createDatabase` itself; each pooled connection's `query` is wrapped when the pool
 * opens it, so pool queries and transactions are recorded once each. Nothing in the application
 * is instrumented.
 */
export function recordingDatabase() {
  const sent: SentStatement[] = [];
  const { db, pool } = createDatabase(connectionString);
  pool.on('connect', (client: pg.PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const [config, values] = args;
      const text = typeof config === 'string' ? config : (config as { text?: string } | null)?.text ?? '';
      const params = Array.isArray(values) ? values : (config as { values?: unknown[] } | null)?.values ?? [];
      sent.push({ text, values: [...params] });
      return query(...args);
    };
  });
  after(() => pool.end());
  /** Runs `work` and returns its result with the statements it sent, in order. */
  async function statements<T>(work: () => Promise<T>): Promise<{ result: T; sent: SentStatement[] }> {
    const start = sent.length;
    const result = await work();
    return { result, sent: sent.slice(start) };
  }
  return { db, pool, statements };
}

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Parent Relationship'?: string;
  'Subplan Name'?: string;
  'Total Cost': number;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

export interface ExplainedPlan {
  Plan: PlanNode;
  JIT?: { Functions: number };
  'Execution Time': number;
  'Planning Time': number;
}

/**
 * EXPLAIN (ANALYZE, FORMAT JSON) of a recorded statement, run again with the same parameters on
 * one connection, inside a transaction whose `settings` apply with SET LOCAL (for example
 * `{ jit: 'on' }`, to see what the plan costs whatever the pool's own settings are).
 */
export async function explainAnalyze(statement: SentStatement, settings: Record<string, string> = {}): Promise<ExplainedPlan> {
  const client = await observer.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(settings)) await client.query(`SELECT set_config($1, $2, true)`, [name, value]);
    const { rows } = await client.query<{ 'QUERY PLAN': [ExplainedPlan] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, statement.values);
    return rows[0]!['QUERY PLAN'][0];
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Rows a plan read from a table: rows each scan of it returned plus those its filter removed, over all loops. */
export function rowsRead(plan: PlanNode, table: string): number {
  let total = 0;
  const visit = (node: PlanNode) => {
    if (node['Relation Name'] === table) total += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return Math.round(total);
}
