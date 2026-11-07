import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AiPrice, BackgroundComputeConnection } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { apiKeySpendToday } from './api-key-spend.js';

const c = schema.backgroundComputeConnections;
const enablements = schema.personalRunEnablements;
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
    id: row.id, ownerUserId: row.ownerUserId, name: row.name, usedForBackground: row.usedForBackground,
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
  price: AiPrice | null; name: string; useForBackground: boolean;
  provider: BackgroundComputeConnection['provider']; model: string; baseUrl: string | null; dailyBudgetCents: number; timeZone: string;
}

/** Owner id is always taken from the authenticated principal by the core use case. */
export function backgroundConnectionRepository(db: Database) {
  return {
    async add(input: NewApiKeyConnection): Promise<BackgroundComputeConnection> {
      return db.transaction(async (tx) => {
        // Serializes one owner's connection changes, so at most one is ever the background connection.
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, input.ownerUserId)).for('update');
        const [background] = await tx.select({ id: c.id }).from(c)
          .where(and(eq(c.ownerUserId, input.ownerUserId), eq(c.usedForBackground, true)));
        // PROV-1: a new connection never replaces another. Only the owner's very first connection serves
        // background comparisons by itself; after that the owner chooses, and a chosen "none" stays none.
        const [existing] = await tx.select({ id: c.id }).from(c)
          .where(and(eq(c.ownerUserId, input.ownerUserId), isNull(c.revokedAt))).limit(1);
        const useForBackground = input.useForBackground || !existing;
        if (useForBackground && background) await tx.update(c).set({ usedForBackground: false }).where(eq(c.id, background.id));
        const [row] = await tx.insert(c).values({
          id: input.id, ownerUserId: input.ownerUserId, name: input.name, usedForBackground: useForBackground,
          provider: input.provider, model: input.model, baseUrl: input.baseUrl,
          inputPriceMicrosPerMTok: input.price?.inputMicrosPerMTok ?? null, outputPriceMicrosPerMTok: input.price?.outputMicrosPerMTok ?? null,
          priceSource: input.price?.source ?? null, priceCheckedOn: input.price?.checkedOn ?? null,
          encryptedKey: input.encryptedKey, keyLastFour: input.keyLastFour, keyFingerprint: input.keyFingerprint,
          dailyBudgetCents: input.dailyBudgetCents, timeZone: input.timeZone,
        }).returning();
        return metadata(tx, row!);
      });
    },
    async list(ownerUserId: string): Promise<BackgroundComputeConnection[]> {
      const rows = await db.select().from(c).where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt)))
        .orderBy(desc(c.usedForBackground), desc(c.createdAt), desc(c.id));
      return Promise.all(rows.map((row) => metadata(db, row)));
    },
    async current(ownerUserId: string): Promise<BackgroundComputeConnection | null> {
      const [row] = await db.select().from(c).where(and(eq(c.ownerUserId, ownerUserId), eq(c.usedForBackground, true), isNull(c.revokedAt)));
      return row ? metadata(db, row) : null;
    },
    async update(ownerUserId: string, connectionId: string, change: { name?: string; dailyBudgetCents?: number; usedForBackground?: true }): Promise<BackgroundComputeConnection | null> {
      return db.transaction(async (tx) => {
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, ownerUserId)).for('update');
        const [target] = await tx.select({ id: c.id }).from(c)
          .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt))).for('update');
        if (!target) return null;
        if (change.usedForBackground) await tx.update(c).set({ usedForBackground: false })
          .where(and(eq(c.ownerUserId, ownerUserId), eq(c.usedForBackground, true)));
        const [row] = await tx.update(c).set({ ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.dailyBudgetCents !== undefined ? { dailyBudgetCents: change.dailyBudgetCents } : {}),
          ...(change.usedForBackground ? { usedForBackground: true } : {}) }).where(eq(c.id, connectionId)).returning();
        return metadata(tx, row!);
      });
    },
    /** The model the owner's assistant runs on this key (#909): the one a budget must also hold one request of. */
    async assistantModelOn(ownerUserId: string, connectionId: string): Promise<string | null> {
      const [row] = await db.select({ model: enablements.assistantModel }).from(enablements)
        .where(and(eq(enablements.ownerUserId, ownerUserId), eq(enablements.connectionId, connectionId), eq(enablements.engine, 'server')));
      return row?.model ?? null;
    },
    async revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, ownerUserId)).for('update');
        // Removing the background connection stops background comparisons: no other connection takes over.
        const [row] = await tx.update(c).set({ encryptedKey: null, revokedAt: new Date(), usedForBackground: false })
          .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt)))
          .returning({ id: c.id });
        return Boolean(row);
      });
    },
  };
}
