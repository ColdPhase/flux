import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AiPrice, BackgroundComputeConnection } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { apiKeySpendToday } from './api-key-spend.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { companyGuestSql } from './access.js';

const c = schema.backgroundComputeConnections;
const settings = schema.assistantSettings;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'update' | 'insert' | 'transaction' | 'execute'>;
type ConnectionRow = typeof c.$inferSelect;

/** The stored price, or null when the connection has none (it cannot be enabled, PROV-3). */
export function connectionPrice(row: Pick<ConnectionRow, 'inputPriceMicrosPerMTok' | 'outputPriceMicrosPerMTok' | 'priceSource' | 'priceCheckedOn'>): AiPrice | null {
  if (row.priceSource === null || row.inputPriceMicrosPerMTok === null || row.outputPriceMicrosPerMTok === null) return null;
  return { inputMicrosPerMTok: row.inputPriceMicrosPerMTok, outputMicrosPerMTok: row.outputPriceMicrosPerMTok,
    source: row.priceSource, checkedOn: row.priceCheckedOn };
}

async function metadata(db: Pick<Database, 'execute'>, row: ConnectionRow): Promise<BackgroundComputeConnection> {
  const spend = await apiKeySpendToday(db, row.id);
  return {
    id: row.id, ownerUserId: row.ownerUserId, name: row.name,
    provider: row.provider, model: row.model, baseUrl: row.baseUrl,
    price: connectionPrice(row),
    keyLastFour: row.keyLastFour, keyFingerprint: row.keyFingerprint,
    dailyBudgetCents: row.dailyBudgetCents, timeZone: row.timeZone,
    today: { spentMicros: spend?.chargedMicros ?? 0, resetsAt: (spend?.resetsAt ?? new Date()).toISOString() },
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a new key stores beyond its sealed secret. */
export interface NewApiKeyConnection {
  id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
  price: AiPrice | null; name: string;
  provider: BackgroundComputeConnection['provider']; model: string; baseUrl: string | null; dailyBudgetCents: number; timeZone: string;
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
        }).returning();
        return metadata(tx, row!);
      });
    },
    /** A guest of the company sees none of their keys and changes none: they are kept, hidden and refused until they are a member again (AG-2, C-50). */
    async list(ownerUserId: string): Promise<BackgroundComputeConnection[]> {
      const rows = await db.select().from(c).where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`))
        .orderBy(desc(c.createdAt), desc(c.id));
      return Promise.all(rows.map((row) => metadata(db, row)));
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
        return metadata(tx, row!);
      });
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
