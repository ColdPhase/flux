import { after } from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '@flux/db';
import { connectionString, pool as observer } from './db.js';

/** One statement as a client sent it. */
export interface SentStatement {
  text: string;
  values: unknown[];
}

/**
 * A Flux database handle (#298) that records every statement its clients send, BEGIN and COMMIT
 * included, so a test can assert how many round trips a use case costs and explain the exact SQL
 * it ran. It is `createDatabase`'s pool and Drizzle setup with a recording client class; nothing
 * in the application is instrumented.
 */
export function recordingDatabase() {
  const sent: SentStatement[] = [];
  class RecordingClient extends pg.Client {
    override query(...args: unknown[]): never {
      const [config, values] = args;
      const text = typeof config === 'string' ? config : (config as { text?: string } | null)?.text ?? '';
      const params = Array.isArray(values) ? values : (config as { values?: unknown[] } | null)?.values ?? [];
      sent.push({ text, values: [...params] });
      return (super.query as (...rest: unknown[]) => never)(...args);
    }
  }
  const pool = new pg.Pool({ connectionString, Client: RecordingClient, connectionTimeoutMillis: 1500, query_timeout: 2000 });
  after(() => pool.end());
  const db = drizzle({ client: pool, schema });
  /** Runs `work` and returns its result with the statements it sent, in order. */
  async function statements<T>(work: () => Promise<T>): Promise<{ result: T; sent: SentStatement[] }> {
    const start = sent.length;
    const result = await work();
    return { result, sent: sent.slice(start) };
  }
  return { db, pool, statements };
}

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Subplan Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/** EXPLAIN (ANALYZE, FORMAT JSON) of a recorded statement, run again with the same parameters. */
export async function explainAnalyze(statement: SentStatement): Promise<PlanNode> {
  const { rows } = await observer.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, statement.values);
  return rows[0]!['QUERY PLAN'][0].Plan;
}

/** Every subplan of a plan (a `SubPlan` relationship) with how often it ran. */
export function subplans(plan: PlanNode): { name: string; loops: number }[] {
  const found: { name: string; loops: number }[] = [];
  const visit = (node: PlanNode) => {
    if (node['Parent Relationship'] === 'SubPlan') found.push({ name: node['Subplan Name'] ?? '', loops: node['Actual Loops'] ?? 0 });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return found;
}
