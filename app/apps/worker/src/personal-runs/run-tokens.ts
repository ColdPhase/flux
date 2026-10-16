import { createHash, randomBytes } from 'node:crypto';
import { personalRunTokenPath, type PersonalRunTokenGrant } from '@flux/contracts';
import type { Database, PersonalRunTokenIssuer } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';

// The worker's side of a run's MCP token (F-027 A2, #280/#484). The API is Flux's authorization server and
// signs it; the worker proves it holds the run with a one-time nonce: it stores the nonce's SHA-256 on the
// run row in its own transaction, then sends the nonce once. The token lives only in memory, for one run.

const ORIGIN = /^http:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** `FLUX_API_INTERNAL_URL`: how the worker reaches the API inside Compose (default `http://api:8080`). */
export function apiInternalUrl(env: NodeJS.ProcessEnv): string {
  const url = (env.FLUX_API_INTERNAL_URL ?? 'http://api:8080').trim().replace(/\/+$/, '');
  if (!ORIGIN.test(url)) throw new Error('FLUX_API_INTERNAL_URL must be http://<host>[:<port>]');
  return url;
}

export function runTokenIssuer(db: Database, apiUrl: string, fetchImpl: typeof fetch = fetch): PersonalRunTokenIssuer {
  return {
    async issue(runId) {
      const nonce = randomBytes(32).toString('hex');
      const armed = await db.transaction((tx) => personalRunTokenRows(tx).arm(runId, createHash('sha256').update(nonce).digest('hex')));
      if (!armed) return null;
      let response: Response;
      try {
        response = await fetchImpl(`${apiUrl}${personalRunTokenPath(runId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }), signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return null;
      }
      if (response.status !== 200) return null;
      const grant = await response.json().catch(() => null) as PersonalRunTokenGrant | null;
      if (!grant || typeof grant.token !== 'string' || !Array.isArray(grant.tools) || grant.tools.some((tool) => typeof tool !== 'string')) return null;
      return { token: grant.token, tools: [...grant.tools], expiresAt: String(grant.expiresAt) };
    },
    async close(runId) {
      await db.transaction((tx) => personalRunTokenRows(tx).close(runId));
    },
  };
}
