import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { currentConnectionPrice, type AiModelList, type AiPrice, type AiPriceLists, type BackgroundComputeConnection } from '@flux/contracts';
import { storedPriceLists } from './ai-price-list.js';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { apiKeySpendToday } from './api-key-spend.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { companyGuestSql } from './access.js';

const c = schema.backgroundComputeConnections;
const settings = schema.assistantSettings;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'update' | 'insert' | 'transaction' | 'execute'>;
type ConnectionRow = typeof c.$inferSelect;

/**
 * The price the connection runs at now, or null when it has none (it cannot be enabled, PROV-3): Flux's price list today when it knows
 * the key's model (#1465), else the stored price.
 */
export function connectionPrice(row: Pick<ConnectionRow, 'provider' | 'model' | 'inputPriceMicrosPerMTok' | 'outputPriceMicrosPerMTok' | 'priceSource' | 'priceCheckedOn'>,
  lists: AiPriceLists): AiPrice | null {
  const stored: AiPrice | null = row.priceSource === null || row.inputPriceMicrosPerMTok === null || row.outputPriceMicrosPerMTok === null ? null
    : { inputMicrosPerMTok: row.inputPriceMicrosPerMTok, outputMicrosPerMTok: row.outputPriceMicrosPerMTok, source: row.priceSource, checkedOn: row.priceCheckedOn };
  return currentConnectionPrice(stored, row.model, lists[row.provider]);
}

async function metadata(db: Pick<Database, 'execute'>, row: ConnectionRow, lists: AiPriceLists): Promise<BackgroundComputeConnection> {
  const spend = await apiKeySpendToday(db, row.id);
  return {
    id: row.id, ownerUserId: row.ownerUserId, name: row.name,
    provider: row.provider, model: row.model, baseUrl: row.baseUrl,
    price: connectionPrice(row, lists),
    keyLastFour: row.keyLastFour, keyFingerprint: row.keyFingerprint,
    dailyBudgetCents: row.dailyBudgetCents, timeZone: row.timeZone,
    today: { spentMicros: spend?.chargedMicros ?? 0, resetsAt: (spend?.resetsAt ?? new Date()).toISOString() },
    createdAt: row.createdAt.toISOString(),
    modelPrices: row.modelPrices ?? {},
  };
}

/** What a new key stores beyond its sealed secret. */
export interface NewApiKeyConnection {
  id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
  price: AiPrice | null; name: string;
  provider: BackgroundComputeConnection['provider']; model: string; baseUrl: string | null; dailyBudgetCents: number; timeZone: string;
  /** The list read with the key while it was added (#1218); absent when none was read. */
  modelList?: AiModelList | null;
}

/** The columns a listing writes (#1218): a list the provider gave replaces the stored one; any other outcome keeps it. */
function listingColumns(list: AiModelList, at: Date, before: { listedModels: schema.StoredListedModel[] | null; retiredModels: string[] } | null) {
  if (list.status !== 'listed') return { modelsCheckedAt: at, modelsListStatus: list.status === 'needs_key' ? 'unavailable' as const : list.status };
  const ids = new Set(list.models.map((model) => model.id));
  // A model of an earlier list that this one lacks is no longer offered; one that is back is offered again (CA-2).
  const retired = [...new Set([...(before?.retiredModels ?? []), ...(before?.listedModels ?? []).map((model) => model.id)])].filter((id) => !ids.has(id)).sort();
  return {
    listedModels: list.models.map((model) => ({ id: model.id, name: model.name ?? null, family: model.family ?? 'Other', createdAt: model.createdAt ?? null })),
    modelsListedAt: at, modelsCheckedAt: at, modelsListStatus: 'listed' as const, retiredModels: retired,
  };
}

/** Owner id is always taken from the authenticated principal by the core use case. */
export function backgroundConnectionRepository(db: Database) {
  return {
    async add(input: NewApiKeyConnection): Promise<BackgroundComputeConnection> {
      return db.transaction(async (tx) => {
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers).where(eq(schema.authUsers.id, input.ownerUserId)).for('update');
        const [row] = await tx.insert(c).values({
          id: input.id, ownerUserId: input.ownerUserId, name: input.name,
          provider: input.provider, model: input.model, baseUrl: input.baseUrl,
          inputPriceMicrosPerMTok: input.price?.inputMicrosPerMTok ?? null, outputPriceMicrosPerMTok: input.price?.outputMicrosPerMTok ?? null,
          priceSource: input.price?.source ?? null, priceCheckedOn: input.price?.checkedOn ?? null,
          encryptedKey: input.encryptedKey, keyLastFour: input.keyLastFour, keyFingerprint: input.keyFingerprint,
          dailyBudgetCents: input.dailyBudgetCents, timeZone: input.timeZone,
          ...(input.modelList ? listingColumns(input.modelList, new Date(), null) : {}),
        }).returning();
        return metadata(tx, row!, await storedPriceLists(tx));
      });
    },
    /** A guest of the company sees none of their keys and changes none: they are kept, hidden and refused until they are a member again (AG-2, C-50). */
    async list(ownerUserId: string): Promise<BackgroundComputeConnection[]> {
      const rows = await db.select().from(c).where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`))
        .orderBy(desc(c.createdAt), desc(c.id));
      const lists = rows.length ? await storedPriceLists(db) : {};
      return Promise.all(rows.map((row) => metadata(db, row, lists)));
    },
    /**
     * `guard` gets the models the owner's agents run on this key, read under the owner's assistant lock (the one a model change
     * takes first), so a budget saved while an agent moves to another model is checked against the model it ends up on (#909, #915).
     * It throws to refuse the change; nothing is written then.
     */
    async update(ownerUserId: string, connectionId: string, change: { name?: string; dailyBudgetCents?: number },
      guard?: (agentModels: readonly string[]) => void): Promise<BackgroundComputeConnection | null> {
      return db.transaction(async (tx) => {
        if (guard) await lockAssistantOwner(tx, ownerUserId);
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, ownerUserId)).for('update');
        const [target] = await tx.select({ id: c.id }).from(c)
          .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`)).for('update');
        if (!target) return null;
        if (guard) {
          const rows = await tx.select({ model: settings.model }).from(settings)
            .where(and(eq(settings.ownerUserId, ownerUserId), eq(settings.apiKeyId, connectionId), eq(settings.engine, 'server')));
          guard([...new Set(rows.flatMap((row) => (row.model ? [row.model] : [])))]);
        }
        const [row] = await tx.update(c).set({ ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.dailyBudgetCents !== undefined ? { dailyBudgetCents: change.dailyBudgetCents } : {}) }).where(eq(c.id, connectionId)).returning();
        return metadata(tx, row!, await storedPriceLists(tx));
      });
    },
    /**
     * Stores what a listing of the key found (#1218), written by the worker, the only process that opens a stored key. A revoked key
     * keeps nothing. Returns whether the key still exists.
     */
    async saveModelList(connectionId: string, list: AiModelList, at: Date = new Date()): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select({ listedModels: c.listedModels, retiredModels: c.retiredModels }).from(c)
          .where(and(eq(c.id, connectionId), isNull(c.revokedAt))).for('update');
        if (!row) return false;
        await tx.update(c).set(listingColumns(list, at, row)).where(eq(c.id, connectionId));
        return true;
      });
    },
    /** When the key's models were last asked for, or null when never, or when the key is not the owner's. */
    async modelsCheckedAt(ownerUserId: string, connectionId: string): Promise<{ checkedAt: Date | null } | null> {
      const [row] = await db.select({ checkedAt: c.modelsCheckedAt }).from(c)
        .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`));
      return row ? { checkedAt: row.checkedAt } : null;
    },
    /**
     * The owner's price for one of the key's models that Flux's price list does not price (PROV-3, #1218, #1465), or null to remove it. Returns
     * false when the key is not the owner's.
     */
    async setModelPrice(ownerUserId: string, connectionId: string, model: string, price: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null): Promise<boolean> {
      const value = price ? sql`jsonb_set(${c.modelPrices}, ARRAY[${model}::text], ${JSON.stringify({ inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok })}::jsonb)`
        : sql`${c.modelPrices} - ${model}::text`;
      const [row] = await db.update(c).set({ modelPrices: value })
        .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`))
        .returning({ id: c.id });
      return Boolean(row);
    },
    async revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, ownerUserId)).for('update');
        const [row] = await tx.update(c).set({ encryptedKey: null, revokedAt: new Date() })
          .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`))
          .returning({ id: c.id });
        return Boolean(row);
      });
    },
  };
}
