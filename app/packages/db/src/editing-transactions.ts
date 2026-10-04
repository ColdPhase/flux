import type pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export class EditingTransactionError extends Error {
  constructor(readonly outcome: 'refused' | 'unknown', cause: unknown) {
    super(outcome === 'unknown' ? 'The commit outcome needs original receipt reconciliation' : 'The live transaction definitely rolled back', { cause });
  }
}
/** An explicit public pg transaction boundary distinguishes failed work/ROLLBACK from a lost COMMIT response. */
export function editingTransactions(pool: Pick<pg.Pool, 'connect'>) {
  return {
    async run<T>(action: (db: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let began = false; let committing = false; let discard = false;
      try {
        // A rejected BEGIN response does not prove the backend never opened a transaction.
        try { await client.query('BEGIN'); began = true; } catch (error) { discard = true; throw error; }
        await client.query("SET LOCAL statement_timeout = '2000ms'");
        await client.query("SET LOCAL lock_timeout = '1500ms'");
        const result = await action(drizzle({ client, schema }));
        committing = true;
        await client.query('COMMIT');
        return result;
      } catch (cause) {
        if (committing) { discard = true; throw new EditingTransactionError('unknown', cause); }
        if (began) {
          try { await client.query('ROLLBACK'); }
          catch { discard = true; throw new EditingTransactionError('unknown', cause); }
        }
        // Preserve a typed policy/codec failure after the definite rollback; callers send no ACK.
        throw cause;
      } finally { client.release(discard); }
    },
  };
}
