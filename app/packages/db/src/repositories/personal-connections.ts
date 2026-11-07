import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AiPrice, AiProviderKind } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { openBackgroundKey } from '../background-key-crypto.js';
import { connectionPrice } from './background-connections.js';

const c = schema.backgroundComputeConnections;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select'>;

/** One owner's connection as the assistant uses it; core's `PersonalConnection` port, structurally. */
export interface PersonalConnectionRow {
  id: string;
  ownerUserId: string;
  status: 'active';
  keyRef: string;
  /** The owner's label for the key, e.g. "Work OpenRouter". */
  name: string;
  provider: AiProviderKind;
  model: string;
  baseUrl: string | null;
  price: AiPrice | null;
  createdAt: Date;
  dailyBudgetCents: number;
  timeZone: string;
}

type Row = typeof c.$inferSelect;
const connectionOf = (row: Row): PersonalConnectionRow => ({
  id: row.id, ownerUserId: row.ownerUserId, status: 'active', keyRef: row.id, name: row.name,
  provider: row.provider, model: row.model, baseUrl: row.baseUrl, price: connectionPrice(row), createdAt: row.createdAt,
  dailyBudgetCents: row.dailyBudgetCents, timeZone: row.timeZone,
});

/**
 * The production lookup of the assistant's connection (#68 "Switching production on" step 1, F-020
 * PROV-1): only `ownerUserId`'s own active connections with a stored key. A `connectionId` returns
 * exactly that one, never another; without one, the owner's newest (used only to describe enabling).
 * The key reference is the connection id; the key itself stays sealed here.
 */
export function personalConnectionLookup(db: Database) {
  return {
    async resolve(ownerUserId: string, connectionId?: string): Promise<PersonalConnectionRow | null> {
      const [row] = await db.select().from(c)
        .where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), isNotNull(c.encryptedKey),
          ...(connectionId !== undefined ? [eq(c.id, connectionId)] : [])))
        .orderBy(desc(c.createdAt), desc(c.id)).limit(1);
      return row ? connectionOf(row) : null;
    },
    /** Every active key of the owner, in the order they were added (Connect AI's order, #854). */
    async list(ownerUserId: string): Promise<PersonalConnectionRow[]> {
      const rows = await db.select().from(c)
        .where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt), isNotNull(c.encryptedKey)))
        .orderBy(asc(c.createdAt), asc(c.id));
      return rows.map(connectionOf);
    },
  };
}

/**
 * The worker's key resolver (#68 step 2): opens the sealed key of one active connection for one
 * dispatch, bound to its owner and id as AEAD associated data. A revoked or unknown connection, or a
 * missing instance key, resolves to null and nothing is sent.
 */
export function personalKeyResolver(db: Database, masterKey: Buffer | null) {
  return async (keyRef: string): Promise<string | null> => {
    if (!masterKey || !/^[0-9a-f-]{36}$/i.test(keyRef)) return null;
    const [row] = await db.select({ id: c.id, ownerUserId: c.ownerUserId, encryptedKey: c.encryptedKey }).from(c)
      .where(and(eq(c.id, keyRef), isNull(c.revokedAt), isNotNull(c.encryptedKey)));
    if (!row?.encryptedKey) return null;
    try { return openBackgroundKey(row.encryptedKey, row.ownerUserId, row.id, masterKey); } catch { return null; }
  };
}
