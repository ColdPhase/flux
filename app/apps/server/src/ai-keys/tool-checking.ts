import { aiEndpointPolicyFromEnv, keyListingOptions, providerToolCheck } from '@flux/agent-runtime';
import type { ToolChecking } from '@flux/core';
import { apiKeyCheckRows, personalKeyResolver, type Database } from '@flux/db';

/**
 * The check that a model of a stored key calls tools (RT-1 rule 2, #1441), for putting an agent on another model of the key: the API opens the
 * sealed key for that one request, the way it does for `flux_web_search` (CA-4), through the same endpoint policy and, in a test deployment, the
 * same mock as the key's listing. Null without the instance key: no key can be sealed or opened then, so there is nothing to check.
 *
 * `db` is the API's own handle, not the transaction of the change: what the check found is recorded there, so a model that is refused still
 * costs what it cost (CA-3), and the next agent on a model that passed finds it recorded.
 */
export function keyToolChecking(env: NodeJS.ProcessEnv, db: Database, masterKey: Buffer | null): ToolChecking | null {
  if (!masterKey) return null;
  const rows = apiKeyCheckRows(db);
  return {
    check: providerToolCheck({ ...keyListingOptions(env, aiEndpointPolicyFromEnv(env)), resolveStoredKey: personalKeyResolver(db, masterKey) }),
    passed: rows.passed,
    record: rows.record,
  };
}
