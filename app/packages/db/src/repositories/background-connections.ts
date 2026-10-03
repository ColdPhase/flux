import { and, eq, isNull } from 'drizzle-orm';
import type { BackgroundComputeConnection, ConnectBackgroundComputeCommand } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

const c = schema.backgroundComputeConnections;
type Database = Pick<ReturnType<typeof createDatabase>['db'], 'select' | 'update' | 'insert' | 'transaction'>;
type ConnectionRow = typeof c.$inferSelect;

function metadata(row: ConnectionRow): BackgroundComputeConnection {
  return {
    id: row.id, ownerUserId: row.ownerUserId, provider: row.provider, model: row.model,
    payerOrganization: row.payerOrganization, providerWorkspace: row.providerWorkspace,
    keyLastFour: row.keyLastFour, keyFingerprint: row.keyFingerprint,
    maxRunsPerDay: row.maxRunsPerDay, periodDays: row.periodDays as 30,
    periodBudgetCents: row.periodBudgetCents, perRunCents: row.perRunCents,
    consentVersion: row.consentVersion, consentedAt: row.consentedAt.toISOString(), createdAt: row.createdAt.toISOString(),
  };
}

/** Owner id is always taken from the authenticated principal by the core use case. */
export function backgroundConnectionRepository(db: Database) {
  return {
    async replace(input: { id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
      command: Omit<ConnectBackgroundComputeCommand, 'apiKey'> }): Promise<BackgroundComputeConnection> {
      return db.transaction(async (tx) => {
        // Serializes two tabs replacing one owner's credential; no duplicate active key.
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, input.ownerUserId)).for('update');
        await tx.update(c).set({ encryptedKey: null, revokedAt: new Date() })
          .where(and(eq(c.ownerUserId, input.ownerUserId), isNull(c.revokedAt)));
        const [row] = await tx.insert(c).values({
          id: input.id, ownerUserId: input.ownerUserId, provider: 'anthropic', model: 'claude-sonnet-5',
          payerOrganization: input.command.payerOrganization, providerWorkspace: input.command.providerWorkspace,
          encryptedKey: input.encryptedKey, keyLastFour: input.keyLastFour, keyFingerprint: input.keyFingerprint,
          maxRunsPerDay: input.command.maxRunsPerDay, periodDays: input.command.periodDays,
          periodBudgetCents: input.command.periodBudgetCents, perRunCents: input.command.perRunCents,
          consentVersion: 'o-007-2026-09-28',
        }).returning();
        return metadata(row!);
      });
    },
    async current(ownerUserId: string): Promise<BackgroundComputeConnection | null> {
      const [row] = await db.select().from(c).where(and(eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt)));
      return row ? metadata(row) : null;
    },
    async revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
          .where(eq(schema.authUsers.id, ownerUserId)).for('update');
        const [row] = await tx.update(c).set({ encryptedKey: null, revokedAt: new Date() })
          .where(and(eq(c.id, connectionId), eq(c.ownerUserId, ownerUserId), isNull(c.revokedAt)))
          .returning({ id: c.id });
        return Boolean(row);
      });
    },
  };
}
