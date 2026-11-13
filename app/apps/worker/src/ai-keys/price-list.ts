import type { PgBoss } from 'pg-boss';
import { aiEndpointPolicyFromEnv, fetchPriceList, keyListingOptions, listProviderModels, priceListFetchOptions } from '@flux/agent-runtime';
import { AI_PRICE_LIST_JOB } from '@flux/contracts';
import { openRouterPriceList } from '@flux/core';
import { aiPriceListRepository, openRouterKeysExist, type Database } from '@flux/db';

/** A stored list older than this is fetched again when the worker starts, besides the daily schedule. */
const STALE_MS = 24 * 3600_000;

/**
 * The model price lists (#1465), fetched every day at 04:17 UTC, and at start when the stored LiteLLM list is older than a day:
 * - LiteLLM's maintained file for Anthropic, OpenAI and Gemini, through the AI egress guard (`fetchPriceList`);
 * - OpenRouter's own model list, without a key, while anyone has an OpenRouter key: what an OpenRouter key pays.
 * Only a list that passes every check replaces its stored one. A failure is logged with its reason, the last good list stays, and the
 * job is retried a few times. The log lines name the list, the outcome, its day and how many models it priced.
 */
export async function registerPriceList(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv = process.env) {
  const policy = aiEndpointPolicyFromEnv(env);
  const options = priceListFetchOptions(env, policy);
  const listing = keyListingOptions(env, policy);
  const store = aiPriceListRepository(db);
  const models = (prices: Record<string, unknown>) => Object.values(prices).reduce<number>((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
  await boss.work(AI_PRICE_LIST_JOB, async () => {
    const failed: string[] = [];
    const litellm = await fetchPriceList(options);
    if (litellm.ok) {
      const stored = await store.store('litellm', litellm.list);
      console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, list: 'litellm', outcome: stored ? 'stored' : 'kept_newer', fetchedOn: litellm.list.fetchedOn, models: models(litellm.list.prices) }));
    } else {
      console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, list: 'litellm', outcome: litellm.reason }));
      failed.push(`litellm: ${litellm.reason}`);
    }
    if (await openRouterKeysExist(db)) {
      const read = await listProviderModels('openrouter', null, listing);
      const list = openRouterPriceList(read);
      if (list) {
        await store.store('openrouter', list);
        console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, list: 'openrouter', outcome: 'stored', fetchedOn: list.fetchedOn, models: models(list.prices) }));
      } else {
        console.log(JSON.stringify({ job: AI_PRICE_LIST_JOB, list: 'openrouter', outcome: read.status === 'listed' ? 'invalid' : read.status }));
        failed.push(`openrouter: ${read.status}`);
      }
    }
    if (failed.length) throw new Error(`A price list could not be fetched: ${failed.join(', ')}`);
  });
  await boss.schedule(AI_PRICE_LIST_JOB, '17 4 * * *');
  const current = await store.read('litellm');
  if (!current || Date.now() - current.storedAt.getTime() > STALE_MS) await boss.send(AI_PRICE_LIST_JOB, {}, { singletonKey: 'start' });
}
