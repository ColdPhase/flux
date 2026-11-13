import { createHash } from 'node:crypto';
import { fillPlaceholders, sql, type SQL } from 'drizzle-orm';
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
  return await session.prepareQuery(built, undefined, statementName(built.sql), false).execute() as { rows: T[] };
}

const names = new Map<string, string>();
function statementName(text: string): string {
  let name = names.get(text);
  if (!name) {
    name = `flux_${createHash('sha256').update(text).digest('base64url').slice(0, 32)}`;
    if (names.size < 1000) names.set(text, name);
  }
  return name;
}

/**
 * A statement of constant text, prepared and run on the executor's connection without Drizzle building it (#1178): for the few lookups
 * that run several times in every request (a person's role in a company, a space's company, the session), where building the query cost
 * more than running it. `text` is a literal; values only ever go in `values`. Rows come back as `pg` parses them.
 */
export async function queryPrepared<T extends Record<string, unknown>>(db: DbExecutor, text: string, values: readonly unknown[]): Promise<{ rows: T[] }> {
  const client = (db as unknown as { session: { client: { query(config: { name: string; text: string }, values: readonly unknown[]): Promise<{ rows: T[] }> } } }).session.client;
  return client.query({ name: statementName(text), text }, values);
}

/**
 * A statement Drizzle composes once (#1178): `build` writes it with `sql.placeholder(name)` for every value, and each run only fills the
 * placeholders and sends the prepared statement. For the work reads' visibility statements, which Drizzle composed from dozens of
 * fragments on every call, and for the access policy's read of a space. The text must not depend on the values (one template per shape).
 */
export function preparedTemplate<T extends Record<string, unknown>>(build: () => SQL) {
  let built: { sql: string; params: unknown[]; name: string } | null = null;
  return async (db: DbExecutor, values: Record<string, unknown>): Promise<{ rows: T[] }> => {
    const session = (db as unknown as { session: PreparingSession & { client: { query(config: { name: string; text: string }, values: unknown[]): Promise<{ rows: T[] }> } } }).session;
    if (!built) { const query = session.dialect.sqlToQuery(build()); built = { ...query, name: statementName(query.sql) }; }
    return session.client.query({ name: built.name, text: built.sql }, fillPlaceholders(built.params, values));
  };
}

/**
 * For a transaction that writes nothing but row locks (an authorization check held `FOR SHARE` while an answer is made or handed over):
 * its COMMIT does not wait for its commit record to reach disk (#1429; the editing fences do the same, `EditingCommit` `transient`). A
 * row lock gives the transaction an id and a WAL record, so its COMMIT waited for a flush, 12-18 ms on a busy disk, three times in every
 * MCP tool call. A crash loses nothing but locks that end with it anyway. Never for a transaction that writes data.
 */
export async function commitWithoutFlush(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`SET LOCAL synchronous_commit = off`);
}
