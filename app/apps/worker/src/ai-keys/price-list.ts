import type { PgBoss } from 'pg-boss';
import { aiEndpointPolicyFromEnv, fetchPriceList, priceListFetchOptions } from '@flux/agent-runtime';
import { AI_PRICE_LIST_JOB } from '@flux/contracts';
import { aiPriceListRepository, type Database } from '@flux/db';

/** A stored list older than this is fetched again when the worker starts, besides the daily schedule. */
const STALE_MS = 24 * 3600_000;

/**
 * Flux's price list (#1465): fetched every day at 04:17 UTC, and at start when the stored one is older than a day, from the maintained
 * public list through the AI egress guard (`fetchPriceList`). Only a list that passes every check replaces the stored one; on a failure
 * the job is retried a few times and the last good list stays (the release's shipped list at worst, stored by the migrator). The log
 * line names the outcome, the list's day and how many models it priced.
 */
export async function registerPriceList(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv = process.env) {
  const options = priceListFetchOptions(env, aiEndpointPolicyFromEnv(env));
  const store = aiPriceListRepository(db);
  await boss.work(AI_PRICE_LIST_JOB, async () => {
    const result = await fetchPriceList(options);
    if (!result.ok) {
      console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, outcome: result.reason }));
      throw new Error(`The price list could not be fetched: ${result.reason}`);
    }
    const stored = await store.store(result.list);
    const models = Object.values(result.list.prices).reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
    console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, outcome: stored ? 'stored' : 'kept_newer', fetchedOn: result.list.fetchedOn, models }));
  });
  await boss.schedule(AI_PRICE_LIST_JOB, '17 4 * * *');
  const current = await store.read();
  if (!current || Date.now() - current.storedAt.getTime() > STALE_MS) await boss.send(AI_PRICE_LIST_JOB, {}, { singletonKey: 'start' });
}
