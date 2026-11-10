import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import type { DbExecutor } from './repositories/push.js';

/** What `executePrepared` reaches of a Drizzle database or transaction: its session, which builds and runs a query on its connection. */
interface PreparingSession {
  dialect: { sqlToQuery(query: SQL): { sql: string; params: unknown[] } };
  prepareQuery(query: { sql: string; params: unknown[] }, fields: undefined, name: string, isResponseInArrayMode: false): { execute(): Promise<unknown> };
}

/**
 * Runs `query` as a named prepared statement on the executor's connection (#1178), where `execute` sends an unnamed one that PostgreSQL
 * plans on every call. A named statement is planned for its first few runs on a connection and then reuses one generic plan, as long
 * as that plan costs no more than the custom ones did. For the few statements whose planning outweighs their execution (the work reads'
 * visibility fingerprint plans in about 1.5 ms and runs in 0.03 ms). The text must have a fixed shape (no list that grows with the input:
 * pass an array as one parameter instead), because each connection keeps every statement it has prepared until it closes. The name is
 * the text's hash, so a changed text is a new statement, never a clash.
 */
export async function executePrepared<T extends Record<string, unknown>>(db: DbExecutor, query: SQL): Promise<{ rows: T[] }> {
  const session = (db as unknown as { session: PreparingSession }).session;
  const built = session.dialect.sqlToQuery(query);
  const name = `flux_${createHash('sha256').update(built.sql).digest('base64url').slice(0, 32)}`;
  return await session.prepareQuery(built, undefined, name, false).execute() as { rows: T[] };
}
