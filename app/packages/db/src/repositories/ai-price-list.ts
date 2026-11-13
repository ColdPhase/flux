import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { priceListsOf, type AiPriceList, type AiPriceLists, type AiProviderKind, type AiProviderPriceList } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

const t = schema.aiPriceLists;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'insert'>;

/** The stored lists (#1465): LiteLLM's, for Anthropic, OpenAI and Gemini, and OpenRouter's own. */
export type PriceListName = 'litellm' | 'openrouter';

/**
 * The model price lists (#1465): one stored row per list, written only with a list that passed `parsePriceList`, `openRouterPriceList`
 * or `isPriceList` (core). The worker stores each day's lists; the release's shipped list is stored when the database has none or an
 * older one; the API stores OpenRouter's when it reads it at connect. A failed fetch writes nothing, so the last good list stays.
 */
export function aiPriceListRepository(db: Database) {
  return {
    async read(list: PriceListName): Promise<(AiPriceList & { storedAt: Date }) | null> {
      const [row] = await db.select().from(t).where(eq(t.list, list));
      return row ? { fetchedOn: row.fetchedOn, source: row.source, prices: row.prices, storedAt: row.storedAt } : null;
    },
    /** Stores `value` as `list` unless the stored one was fetched later (or, with `sameDay: 'keep'`, on the same day). True when stored. */
    async store(list: PriceListName, value: AiPriceList, sameDay: 'replace' | 'keep' = 'replace'): Promise<boolean> {
      const newer = sameDay === 'replace' ? sql`${t.fetchedOn} <= excluded.fetched_on` : sql`${t.fetchedOn} < excluded.fetched_on`;
      const rows = await db.insert(t).values({ list, fetchedOn: value.fetchedOn, source: value.source, prices: value.prices })
        .onConflictDoUpdate({ target: t.list, set: { fetchedOn: sql`excluded.fetched_on`, source: sql`excluded.source`, prices: sql`excluded.prices`, storedAt: sql`now()` },
          setWhere: newer })
        .returning({ list: t.list });
      return rows.length > 0;
    },
  };
}

/** Every provider's stored price list, read once for every connection a query returns. */
export async function storedPriceLists(db: Pick<Database, 'select'>): Promise<AiPriceLists> {
  const rows = await db.select({ fetchedOn: t.fetchedOn, source: t.source, prices: t.prices }).from(t);
  return priceListsOf(rows);
}

/** One provider's stored price list, or null when no list carries the provider. */
export async function storedProviderPriceList(db: Pick<Database, 'select'>, provider: AiProviderKind): Promise<AiProviderPriceList | null> {
  return (await storedPriceLists(db))[provider] ?? null;
}

/** Whether anyone has an active OpenRouter key: OpenRouter's prices are read every day only then (#1465). */
export async function openRouterKeysExist(db: Pick<Database, 'select'>): Promise<boolean> {
  const c = schema.backgroundComputeConnections;
  const [row] = await db.select({ id: c.id }).from(c)
    .where(and(eq(c.provider, 'openrouter'), isNull(c.revokedAt), isNotNull(c.encryptedKey))).limit(1);
  return !!row;
}
