// Core's transaction port (issues #46, #92). Core never reads or writes through a handle itself: a use
// case opens a transaction on the handle it is given and passes the handle to the port factories the app
// supplies (`accessPorts`, `eventRepository`, the idempotency store, ...), which bind their adapters to it.
// A `@flux/db` pool handle or open transaction satisfies these types; core names no persistence library.

/** A connection or an open transaction. Opaque to core: only ports bound to it run statements. */
export type Executor = object;

/**
 * A handle that opens a transaction: on a pool handle a new one, on an open transaction a nested one
 * (a savepoint), so a caller such as the idempotency layer can run a use case and record its result in
 * one commit. `Tx` is the handle the work runs on.
 */
export interface TransactionPort<Tx extends Executor> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/** What use cases take: a pool handle or an open transaction, on which they open their own (nested) transaction. */
export interface Database extends TransactionPort<Database> {
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
}

export type { Principal } from './principal.js';
