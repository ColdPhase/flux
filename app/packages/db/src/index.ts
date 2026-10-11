import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export { schema };
export { sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
export * from './repositories/sessions.js';
export * from './repositories/agent-proposals.js';
export * from './repositories/agent-connections.js';
export * from './repositories/agent-mcp-policy.js';
export * from './repositories/project-agents.js';
export * from './repositories/agent-project-objects.js';
export * from './migrations/ledger.js';
export * from './migrations/summary-compatibility.js';
// Highest numbered file in packages/db/migrations. The API refuses other versions.
export const FLUX_SCHEMA_VERSION = 72;
// pg-boss 12.35.0 declares schema 43. Update this with the pinned package.
export const PG_BOSS_SCHEMA_VERSION = 43;

// A session left idle inside a transaction for this long is ended by PostgreSQL (#234). Flux never
// waits on anything outside the database inside a transaction, so only an abandoned client hits it.
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How long a pool waits to hand out a connection, whether queued behind busy clients or opening a new
 * one. 1.5 s by default; `FLUX_DB_CONNECT_TIMEOUT_MS` sets it. The Docker test stack sets 10 s for new
 * connections and short waits while other stacks share the host (#271, docs/development/containers.md).
 */
export const DEFAULT_DB_CONNECT_TIMEOUT_MS = 1500;
export function databaseConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FLUX_DB_CONNECT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_DB_CONNECT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Error('FLUX_DB_CONNECT_TIMEOUT_MS must be an integer from 100 to 60000');
  return value;
}

/**
 * Flux's connections never JIT-compile (#298). Its statements are short reads and writes; when a
 * policy filter inflates a plan's estimate past `jit_above_cost`, compiling took 50–300 ms for
 * statements that execute in a few milliseconds (docs/development/performance-2026-10.md).
 */
export const DATABASE_SESSION_OPTIONS = `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS} -c jit=off`;

export function createDatabase(connectionString: string, connectTimeoutMs = databaseConnectTimeoutMs()) {
  // A client whose BEGIN or ROLLBACK fails is destroyed by the drizzle-orm patch in app/patches (#234).
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: connectTimeoutMs, query_timeout: 2000,
    options: DATABASE_SESSION_OPTIONS });
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}
export * from './repositories/push.js';
export * from './repositories/stream.js';
export * from './repositories/sketches.js';
export * from './repositories/work.js';
export * from './repositories/work-read-keys.js';
export * from './repositories/work-read-visibility.js';
export * from './repositories/work-read-objects.js';
export * from './repositories/work-read-references.js';
export * from './repositories/work-read-thoughts.js';
export * from './repositories/work-read-summary.js';
export * from './repositories/work-read-associations.js';
export * from './repositories/task-graph.js';
export * from './repositories/task-discussions.js';
export * from './repositories/direct-messages.js';
export * from './repositories/docs.js';
export * from './repositories/sample.js';
export * from './repositories/fixture-oauth-clients.js';
export * from './repositories/idempotency.js';
export * from './repositories/draft-results.js';
export * from './repositories/events.js';

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
  let current: pg.Client | null = null;
  let closed = false;
  let generation = 0;
  let timer: NodeJS.Timeout | null = null;
  const connect = async () => {
    if (closed) return;
    const next = new pg.Client({ connectionString });
    const attempt = ++generation;
    let lost = false;
    let ready = false;
    current = next; // Fence the attempt before either awaited connect or LISTEN.
    const live = () => !closed && !lost && current === next && generation === attempt;
    const fail = (error: Error) => {
      if (!live()) return;
      lost = true;
      ready = false;
      current = null;
      generation++;
      void next.end().catch(() => undefined);
      if (!closed && !timer) timer = setTimeout(() => { timer = null; void connect(); }, 1000);
      onError(error);
    };
    next.on('notification', (message) => { if (live() && ready && message.channel === channel) onNotify(message.payload ?? ''); });
    next.on('error', fail);
    next.on('end', () => fail(new Error('Notification listener ended')));
    try {
      await next.connect();
      if (!live()) { await next.end().catch(() => undefined); return; }
      await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      if (!live()) { await next.end().catch(() => undefined); return; }
      ready = true;
      onReconnect();
    } catch (error) { fail(error as Error); }
  };
  void connect();
  return {
    async close() {
      closed = true;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      const closing = current;
      current = null;
      await closing?.end().catch(() => undefined);
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

export * from './repositories/typing.js';
export * from './repositories/cowork.js';
export * from './repositories/cowork-requests.js';
export * from './repositories/cowork-recovery.js';
export * from './repositories/cowork-admission.js';
export * from './repositories/cowork-responses.js';
export * from './repositories/cowork-unit-creation.js';
export * from './repositories/cowork-unit-transitions.js';
export * from './repositories/github.js';
export * from './repositories/agent-execution.js';
export * from './repositories/agent-orientation.js';
export * from './repositories/agent-playbook.js';
export * from './repositories/agent-policies.js';

export * from './repositories/files.js';
export * from './repositories/agent-runtime.js';
