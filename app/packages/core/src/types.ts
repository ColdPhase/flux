import type { createDatabase } from '@flux/db';

/** The pool-backed Drizzle handle created by `createDatabase`. */
export type DatabaseHandle = ReturnType<typeof createDatabase>['db'];
/**
 * What domain methods need: a pool handle or an open transaction. Domain methods open
 * their own (nested, savepoint) transaction on it, so a caller such as the idempotency
 * layer can run a command and record its result atomically.
 */
export type Database = Pick<DatabaseHandle, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>;
/** A database handle or an open transaction; policy checks inside a transaction see its writes. */
export type Executor = Pick<Database, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Transaction = Parameters<Parameters<DatabaseHandle['transaction']>[0]>[0];

export type { Principal } from './principal.js';
