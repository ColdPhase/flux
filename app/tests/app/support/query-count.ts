import { drizzle } from 'drizzle-orm/node-postgres';
import { createDatabase, schema, type Database } from '@flux/db';
import { connectionString } from './db.js';

/**
 * A database handle that counts the statements it sends (BEGIN and COMMIT included), for the tests that pin a read to a number of
 * queries that does not grow with the page (#394, #298, #828). It has its own small pool and is closed with `close()`.
 */
export function countingDatabase() {
  const { pool } = createDatabase(connectionString, undefined, { max: 2 });
  let statements = 0;
  const db = drizzle({ client: pool, schema, logger: { logQuery: () => { statements += 1; } } }) as unknown as Database;
  return {
    db,
    /** Statements sent by `work` alone. */
    async count(work: () => Promise<unknown>) {
      const before = statements;
      await work();
      return statements - before;
    },
    close: () => pool.end(),
  };
}
