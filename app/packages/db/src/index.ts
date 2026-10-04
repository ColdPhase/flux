import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export { schema };
export { sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
export * from './repositories/sessions.js';
export * from './repositories/agent-proposals.js';
export * from './repositories/agent-connections.js';
export * from './repositories/agent-project-objects.js';
export * from './migrations/ledger.js';
// Highest numbered file in packages/db/migrations. The API refuses other versions.
export const FLUX_SCHEMA_VERSION = 44;
// pg-boss 12.35.0 declares schema 43. Update this with the pinned package.
export const PG_BOSS_SCHEMA_VERSION = 43;

// A session left idle inside a transaction for this long is ended by PostgreSQL (#234). Flux never
// waits on anything outside the database inside a transaction, so only an abandoned client hits it.
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function createDatabase(connectionString: string) {
  // A client whose BEGIN or ROLLBACK fails is destroyed by the drizzle-orm patch in app/patches (#234).
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1500, query_timeout: 2000,
    options: `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}` });
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}
export * from './repositories/push.js';
export * from './repositories/stream.js';
export * from './repositories/sketches.js';
export * from './repositories/work.js';
export * from './repositories/task-graph.js';
export * from './repositories/task-discussions.js';
export * from './repositories/direct-messages.js';
export * from './repositories/docs.js';
export * from './repositories/sample.js';
export * from './repositories/idempotency.js';
export * from './repositories/draft-results.js';

/** PostgreSQL channel notified (payload: seq) after an event with a workspace commits; wakes stream connections. */
export const EVENTS_CHANNEL = 'flux_events';

export interface NotificationListener {
  close(): Promise<void>;
}

/**
 * Keeps one dedicated connection LISTENing on `channel` and reconnects after errors.
 * Notifications are wake-ups only; callers must re-read the table they describe.
 * `onReconnect` fires after each (re)connection so callers can catch up on anything missed.
 */
export function listen(connectionString: string, channel: string, onNotify: (payload: string) => void, onReconnect: () => void = () => undefined, onError: (error: Error) => void = () => undefined): NotificationListener {
  let client: pg.Client | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const connect = async () => {
    if (closed) return;
    const next = new pg.Client({ connectionString });
    next.on('notification', (message) => { if (message.channel === channel) onNotify(message.payload ?? ''); });
    next.on('error', (error) => { onError(error); retry(next); });
    try {
      await next.connect();
      await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      if (closed) { await next.end(); return; }
      client = next;
      onReconnect();
    } catch (error) {
      onError(error as Error);
      retry(next);
    }
  };
  const retry = (failed: pg.Client) => {
    if (client === failed) client = null;
    failed.end().catch(() => undefined);
    if (!closed && !timer) timer = setTimeout(() => { timer = null; void connect(); }, 1000);
  };
  void connect();
  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await client?.end().catch(() => undefined);
      client = null;
    },
  };
}
export * from './repositories/returns.js';
export * from './repositories/proactive-comparison.js';
export * from './repositories/background-connections.js';
export * from './repositories/personal-connections.js';
export * from './repositories/proactive-outbox.js';
export * from './repositories/proactive-outcomes.js';
export * from './repositories/proactive-scheduling.js';
export * from './repositories/proactive-recovery.js';
export { COMPARISON_CONTEXT_LIMITS } from './repositories/proactive-sources.js';
export * from './background-key-crypto.js';
export * from './repositories/notifications.js';
export * from './repositories/search.js';
export * from './repositories/personal-runs.js';
export * from './repositories/project-export.js';
export * from './repositories/operations.js';
export * from './repositories/cowork.js';
export * from './repositories/cowork-requests.js';
export * from './repositories/cowork-recovery.js';
export * from './repositories/github.js';
export * from './repositories/agent-execution.js';
export * from './repositories/agent-orientation.js';
export * from './repositories/agent-playbook.js';
export * from './repositories/agent-policies.js';
