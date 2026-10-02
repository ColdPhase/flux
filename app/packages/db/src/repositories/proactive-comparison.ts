import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CreateProactiveComparisonRule, ProactiveComparisonRule } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { connectionPrice } from './background-connections.js';

const table = schema.proactiveComparisonRules;
type RuleRow = typeof table.$inferSelect;

function view(row: RuleRow): ProactiveComparisonRule {
  return {
    id: row.id, projectId: row.projectId, ownerUserId: row.ownerUserId, agentId: row.agentId,
    trigger: row.triggerKind, purpose: row.purpose, dataScope: row.dataScope, permittedEffect: row.permittedEffect,
    maxRunsPerDay: row.maxRunsPerDay, periodBudgetCents: row.periodBudgetCents, perRunCents: row.perRunCents,
    status: row.status, version: row.version, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** Storage only; the core use case supplies today's project policy decision in the same transaction. */
export function proactiveRuleRows(db: DbExecutor) {
  return {
    async agentMayPropose(ownerId: string, projectId: string, agentId: string) {
      const [row] = await db.select({ id: schema.agents.id }).from(schema.agents)
        .innerJoin(schema.projectGrants, and(eq(schema.projectGrants.agentId, schema.agents.id),
          eq(schema.projectGrants.projectId, projectId), eq(schema.projectGrants.role, 'contributor')))
        .where(and(eq(schema.agents.id, agentId), eq(schema.agents.ownerUserId, ownerId), isNull(schema.agents.revokedAt)));
      return Boolean(row);
    },
    async backgroundBudget(ownerId: string) {
      const c = schema.backgroundComputeConnections;
      const [row] = await db.select({ maxRunsPerDay: c.maxRunsPerDay, periodDays: c.periodDays,
        periodBudgetCents: c.periodBudgetCents, perRunCents: c.perRunCents,
        inputPriceMicrosPerMTok: c.inputPriceMicrosPerMTok, outputPriceMicrosPerMTok: c.outputPriceMicrosPerMTok,
        priceSource: c.priceSource, priceCheckedOn: c.priceCheckedOn }).from(c)
        .where(and(eq(c.ownerUserId, ownerId), isNull(c.revokedAt))).for('share');
      if (!row) return null;
      return { maxRunsPerDay: row.maxRunsPerDay, periodDays: row.periodDays, periodBudgetCents: row.periodBudgetCents,
        perRunCents: row.perRunCents, price: connectionPrice(row) };
    },
    async create(input: { id: string; workspaceId: string; projectId: string; ownerUserId: string; command: CreateProactiveComparisonRule }): Promise<ProactiveComparisonRule | 'EXISTS'> {
      const [row] = await db.insert(table).values({
        id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, ownerUserId: input.ownerUserId,
        agentId: input.command.agentId, triggerKind: input.command.trigger, purpose: input.command.purpose,
        dataScope: input.command.dataScope, permittedEffect: input.command.permittedEffect,
        maxRunsPerDay: input.command.maxRunsPerDay, periodBudgetCents: input.command.periodBudgetCents,
        perRunCents: input.command.perRunCents,
      }).onConflictDoNothing().returning();
      return row ? view(row) : 'EXISTS';
    },
    async list(ownerId: string, projectId: string) {
      return (await db.select().from(table).where(and(eq(table.ownerUserId, ownerId), eq(table.projectId, projectId)))).map(view);
    },
    async find(ownerId: string, ruleId: string) {
      const [row] = await db.select().from(table).where(and(eq(table.id, ruleId), eq(table.ownerUserId, ownerId))).for('update');
      return row ? view(row) : null;
    },
    async change(ownerId: string, ruleId: string, expectedVersion: number, status: 'enabled' | 'paused' | 'revoked') {
      const [row] = await db.update(table).set({ status, version: sql`${table.version} + 1`, updatedAt: new Date(),
        ...(status === 'revoked' ? { revokedAt: new Date() } : {}) })
        .where(and(eq(table.id, ruleId), eq(table.ownerUserId, ownerId), eq(table.version, expectedVersion))).returning();
      return row ? view(row) : null;
    },
  };
}
