import type { createDatabase } from '@flux/db';

export type Database = ReturnType<typeof createDatabase>['db'];
/** A database handle or an open transaction; policy checks inside a transaction see its writes. */
export type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * The authenticated actor of a request, job or tool call. Entry points establish it
 * (session cookie, later OAuth token or job owner) and pass it to domain methods.
 */
export interface Principal {
  id: string;
  kind: 'fixture' | 'human' | 'agent';
}
