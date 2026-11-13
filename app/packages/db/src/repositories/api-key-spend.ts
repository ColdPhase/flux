import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/** Today's use of one API key's daily budget, from the start of the key's day in its own time zone. */
export interface ApiKeySpend {
  budgetCents: number;
  timeZone: string;
  /** Spent by finished work: observed costs, and the most a run of unknown cost could have cost. */
  chargedMicros: number;
  /** Held by work in progress until it ends: never shown as spent. */
  reservedMicros: number;
  resetsAt: Date;
}

/** The budget of a key: read from its row, or given by the caller that already holds it (a test fixture key has no row). */
export interface ApiKeyBudget { dailyBudgetCents: number; timeZone: string }

/**
 * The one daily budget of an API key (#854): everything that runs on the key counts against it, the owner's agents'
 * runs, in the worker or in the runtime through the model gateway (#1441; a plan's run has no key), on the day the money was held: a request that waited overnight counts when it
 * starts. A run whose cost is unknown keeps what its reservation still holds counted. The checks that a model of the key calls tools (#1441, RT-1
 * rule 2, `api_key_checks`) are requests like any other: each one's charge counts on the day it was made. Null when the key does not exist. `exceptRunId` leaves one run out (its own reservation, while it is being rechecked).
 */
export async function apiKeySpendToday(db: Pick<DbExecutor, 'execute'>, connectionId: string, exceptRunId?: string, budget?: ApiKeyBudget, at?: Date): Promise<ApiKeySpend | null> {
  const now = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  const key = budget
    ? sql`SELECT ${budget.dailyBudgetCents}::int AS daily_budget_cents, ${budget.timeZone}::text AS time_zone`
    : sql`SELECT daily_budget_cents, time_zone FROM background_compute_connections WHERE id = ${connectionId}`;
  const except = exceptRunId ? sql`AND r.id <> ${exceptRunId}` : sql``;
  // The next day starts at the next local midnight, not 24 hours on: a day with a clock change has 23 or 25 hours (#910). Where the clocks
  // go back at midnight (Havana) that midnight comes twice, and PostgreSQL reads the local time as the later one: the day began at the
  // earlier, an hour before (#915). `first` takes the earlier instant that shows the same local time.
  const result = await db.execute(sql`WITH b AS (${key}),
    d AS (SELECT daily_budget_cents, time_zone, date_trunc('day', ${now} AT TIME ZONE time_zone) AS local_day FROM b),
    s AS (SELECT daily_budget_cents, time_zone, local_day, (local_day AT TIME ZONE time_zone) AS at_start, ((local_day + interval '1 day') AT TIME ZONE time_zone) AS at_next,
      (local_day + interval '1 day') AS local_next FROM d),
    k AS (SELECT daily_budget_cents, time_zone,
      CASE WHEN ((at_start - interval '1 hour') AT TIME ZONE time_zone) = local_day THEN at_start - interval '1 hour' ELSE at_start END AS start,
      CASE WHEN ((at_next - interval '1 hour') AT TIME ZONE time_zone) = local_next THEN at_next - interval '1 hour' ELSE at_next END AS next_start FROM s)
    SELECT k.daily_budget_cents AS budget, k.time_zone AS zone, k.next_start AS resets_at,
      (SELECT COALESCE(sum(r.charged_micros) FILTER (WHERE r.cost_state = 'observed'), 0) + COALESCE(sum(r.reserved_micros) FILTER (WHERE r.cost_state = 'unknown'), 0) FROM personal_runs r
        WHERE r.connection_id = ${connectionId} AND r.reserved_at >= k.start ${except})::bigint
      + (SELECT COALESCE(sum(c.charged_micros), 0) FROM api_key_checks c WHERE c.connection_id = ${connectionId} AND c.checked_at >= k.start)::bigint AS run_charged,
      (SELECT COALESCE(sum(r.reserved_micros) FILTER (WHERE r.cost_state = 'reserved'), 0) FROM personal_runs r
        WHERE r.connection_id = ${connectionId} AND r.reserved_at >= k.start ${except})::bigint AS run_reserved
    FROM k`);
  const row = result.rows[0] as {
    budget: number; zone: string; resets_at: Date | string; run_charged: string | number; run_reserved: string | number;
  } | undefined;
  if (!row) return null;
  return {
    budgetCents: Number(row.budget), timeZone: row.zone, resetsAt: new Date(row.resets_at),
    chargedMicros: Number(row.run_charged),
    reservedMicros: Number(row.run_reserved),
  };
}
