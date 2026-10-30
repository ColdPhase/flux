import type { createDatabase } from './index.js';

// The Drizzle handles the apps hold (issues #46, #92). They moved here from `@flux/core`, which now owns only
// its transaction port (`Database`, `Executor`, `TransactionPort` in core's `types.ts`); these handles
// satisfy that port, so the apps pass them to core use cases unchanged.

/** The pool-backed Drizzle handle created by `createDatabase`. */
export type DatabaseHandle = ReturnType<typeof createDatabase>['db'];
/**
 * A pool handle or an open transaction. Domain methods open their own (nested, savepoint) transaction
 * on it, so a caller such as the idempotency layer can run a command and record its result atomically.
 */
export type Database = Pick<DatabaseHandle, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>;
/** A database handle or an open transaction; policy checks inside a transaction see its writes. */
export type Executor = Pick<Database, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Transaction = Parameters<Parameters<DatabaseHandle['transaction']>[0]>[0];
