import { sql } from 'drizzle-orm';
import type { AiPriceList, AiProviderKind, AiProviderPriceList } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

const t = schema.aiPriceList;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'insert'>;

/**
 * Flux's price list (#1465): one stored row, written only with a list that passed `parsePriceList`/`isPriceList` (core). The worker
 * stores each day's list; the release's shipped list is stored when the database has none or an older one. A failed fetch writes
 * nothing, so the last good list stays.
 */
export function aiPriceListRepository(db: Database) {
  return {
    async read(): Promise<(AiPriceList & { storedAt: Date }) | null> {
      const [row] = await db.select().from(t).limit(1);
      return row ? { fetchedOn: row.fetchedOn, source: row.source, prices: row.prices, storedAt: row.storedAt } : null;
    },
    /**
     * Stores `list` unless the stored one was fetched later (or, with `sameDay: 'keep'`, on the same day). True when it was stored.
     */
    async store(list: AiPriceList, sameDay: 'replace' | 'keep' = 'replace'): Promise<boolean> {
      const newer = sameDay === 'replace' ? sql`${t.fetchedOn} <= excluded.fetched_on` : sql`${t.fetchedOn} < excluded.fetched_on`;
      const rows = await db.insert(t).values({ id: 1, fetchedOn: list.fetchedOn, source: list.source, prices: list.prices })
        .onConflictDoUpdate({ target: t.id, set: { fetchedOn: sql`excluded.fetched_on`, source: sql`excluded.source`, prices: sql`excluded.prices`, storedAt: sql`now()` },
          setWhere: newer })
        .returning({ id: t.id });
      return rows.length > 0;
    },
  };
}

/** The stored list, read once for every connection a query returns; null before the first list is stored. */
export async function storedPriceList(db: Pick<Database, 'select'>): Promise<AiPriceList | null> {
  const [row] = await db.select({ fetchedOn: t.fetchedOn, source: t.source, prices: t.prices }).from(t).limit(1);
  return row ?? null;
}

/** One provider's part of the stored list (`providerPriceList` of contracts, read straight from the row). */
export async function storedProviderPriceList(db: Pick<Database, 'select'>, provider: AiProviderKind): Promise<AiProviderPriceList | null> {
  const [row] = await db.select({ fetchedOn: t.fetchedOn, prices: sql<Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }> | null>`${t.prices} -> ${provider}::text` })
    .from(t).limit(1);
  return row ? { fetchedOn: row.fetchedOn, prices: row.prices ?? {} } : null;
}
