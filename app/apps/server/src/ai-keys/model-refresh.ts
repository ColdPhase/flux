import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { API_KEY_MODEL_LIST_FRESH_MS, API_KEY_MODEL_LIST_JOB, type ApiKeyModelListJob } from '@flux/contracts';
import { schema, type Database } from '@flux/db';

// Reading a stored key's models again (CA-2, #1218). Only the worker opens a stored key (CA-4), so the API asks it with a job that
// names the key, never carries it: when a picker opens and the key's last reading is over 6 hours old, and on Try again, which
// waits for the worker's answer (the listing itself is bounded at 8 seconds).

const c = schema.backgroundComputeConnections;
const KEY_LISTED = ['anthropic', 'openai', 'gemini'] as const;

export interface ModelListRefresh {
  /** Asks the worker to read the owner's keys whose list is older than 6 hours, or was never read. Never waits. */
  requestStale(ownerUserId: string): Promise<void>;
  /**
   * Reads one key's list again and waits for it, up to `waitMs`. Null when the key is not the owner's; otherwise whether a reading
   * finished while waiting.
   */
  refreshNow(ownerUserId: string, connectionId: string, waitMs?: number): Promise<{ finished: boolean } | null>;
}

export function modelListRefresh(db: Database, boss: Pick<PgBoss, 'send'>, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): ModelListRefresh {
  const own = (ownerUserId: string) => and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), isNotNull(c.encryptedKey), inArray(c.provider, [...KEY_LISTED]));
  const send = (connectionId: string) => boss.send(API_KEY_MODEL_LIST_JOB, { connectionId } satisfies ApiKeyModelListJob,
    // The queue is `short` (tooling/migrate.ts): one waiting job per key, so a second ask while one waits joins it.
    { singletonKey: connectionId, retryLimit: 0 });
  return {
    async requestStale(ownerUserId) {
      const stale = await db.select({ id: c.id }).from(c).where(and(own(ownerUserId),
        or(isNull(c.modelsCheckedAt), lt(c.modelsCheckedAt, new Date(Date.now() - API_KEY_MODEL_LIST_FRESH_MS)))));
      for (const row of stale) await send(row.id);
    },
    async refreshNow(ownerUserId, connectionId, waitMs = 10_000) {
      const checked = async () => {
        const [row] = await db.select({ at: c.modelsCheckedAt }).from(c).where(and(own(ownerUserId), eq(c.id, connectionId)));
        return row ? { at: row.at?.getTime() ?? 0 } : null;
      };
      const before = await checked();
      if (!before) return null;
      await send(connectionId);
      for (let waited = 0; waited < waitMs; waited += 250) {
        await sleep(250);
        const after = await checked();
        if (!after) return null;
        if (after.at > before.at) return { finished: true };
      }
      return { finished: false };
    },
  };
}
