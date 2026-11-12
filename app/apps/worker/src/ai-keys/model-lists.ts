import type { PgBoss } from 'pg-boss';
import { aiEndpointPolicyFromEnv, keyListingOptions, listKeyModels } from '@flux/agent-runtime';
import { API_KEY_MODEL_LIST_JOB, type ApiKeyModelListJob } from '@flux/contracts';
import { backgroundConnectionRepository, keyForModelListing, loadBackgroundMasterKey, type Database } from '@flux/db';

/**
 * Reads a stored key's models from its provider (CA-2, #1218): asked by the API when a picker opens on a list over 6 hours old, and
 * by Try again. The worker is the only process that opens a stored key (CA-4); the job names the key, never carries it. Every
 * outcome is stored, so a picker can say the list couldn't be read; a list the provider gave replaces the stored one and marks the
 * models it no longer has. The log line names the key's id and the outcome only.
 */
export async function registerApiKeyModelLists(boss: PgBoss, db: Database, env: NodeJS.ProcessEnv = process.env) {
  const options = keyListingOptions(env, aiEndpointPolicyFromEnv(env));
  const open = keyForModelListing(db, loadBackgroundMasterKey());
  const store = backgroundConnectionRepository(db);
  await boss.work<ApiKeyModelListJob>(API_KEY_MODEL_LIST_JOB, async (jobs) => {
    for (const job of jobs) {
      const key = await open(String(job.data?.connectionId ?? ''));
      if (!key) { console.log(JSON.stringify({ job: API_KEY_MODEL_LIST_JOB, id: job.id, outcome: 'no_key' })); continue; }
      const list = await listKeyModels(key.provider, key.apiKey, options);
      await store.saveModelList(job.data.connectionId, list);
      console.log(JSON.stringify({ job: API_KEY_MODEL_LIST_JOB, id: job.id, outcome: list.status, models: list.models.length }));
    }
  });
}
