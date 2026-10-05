import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AgentJsonValue, AgentPostcondition, AgentStandingGrant, CreateAgentStandingGrantCommand } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Receipt = typeof schema.agentCommandReceipts.$inferInsert;
const runtime = schema.agentRuntimeSessions;
const grants = schema.agentStandingGrants;
const receipts = schema.agentCommandReceipts;
function grantView(row: typeof grants.$inferSelect): AgentStandingGrant {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, connectionId: row.connectionId,
    operation: row.operation, peerRequestClass: row.peerRequestClass, objectId: row.objectId,
    audience: { kind: 'project', projectId: row.projectId }, maximumUses: row.maximumUses, used: row.used,
    expiresAt: row.expiresAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null, generation: row.generation, createdAt: row.createdAt.toISOString() };
}

/** Rows/locks only. The caller owns the open transaction and supplies core authorization. */
export function agentExecutionRows(tx: DbExecutor) {
  return {
    async ownedConnection(ownerUserId: string, connectionId: string) {
      const table = schema.agentConnections;
      const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, connectionId), eq(table.ownerUserId, ownerUserId))).for('share');
      return row ?? null;
    },
    async now(): Promise<Date> {
      // Raw SQL bypasses Drizzle's timestamp column mapper; pg may return text.
      const result = await tx.execute<{ at: Date | string }>(sql`SELECT clock_timestamp() AS at`);
      const at = new Date(result.rows[0]!.at);
      if (!Number.isFinite(at.getTime())) throw new Error('Database wall clock is unavailable');
      return at;
    },
    async lockBinding(id: string) {
      const [row] = await tx.select().from(schema.agentOauthBindings).where(eq(schema.agentOauthBindings.id, id)).for('share');
      return row ?? null;
    },
    async lockRuntime(id: string) {
      const [row] = await tx.select().from(runtime).where(eq(runtime.id, id)).for('share');
      return row ?? null;
    },
    async ensureRuntime(input: typeof runtime.$inferInsert) {
      await tx.insert(runtime).values(input).onConflictDoNothing();
      const [row] = await tx.select().from(runtime).where(and(eq(runtime.bindingId, input.bindingId),
        eq(runtime.clientSessionId, input.clientSessionId))).for('share');
      return row!;
    },
    async lockGrant(id: string) {
      const [row] = await tx.select().from(grants).where(eq(grants.id, id)).for('update');
      return row ?? null;
    },
    async lockCommand(connectionId: string, commandId: string) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flux.agent-command:${connectionId}:${commandId}`}, 0))`);
    },
    async receipt(connectionId: string, commandId: string) {
      const [row] = await tx.select().from(receipts).where(and(eq(receipts.connectionId, connectionId), eq(receipts.clientCommandId, commandId)));
      return row ?? null;
    },
    async sourceVersion(workspaceId: string, projectId: string, id: string) {
      const table = schema.projectMaterials;
      const [row] = await tx.select({ version: table.currentVersion }).from(table)
        .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId), eq(table.projectId, projectId))).for('share');
      return row?.version ?? null;
    },
    async debit(id: string, generation: number): Promise<boolean> {
      return (await tx.update(grants).set({ used: sql`${grants.used} + 1` }).where(and(eq(grants.id, id),
        eq(grants.generation, generation), isNull(grants.revokedAt), gt(grants.expiresAt, sql`clock_timestamp()`),
        sql`${grants.used} < ${grants.maximumUses}`)).returning({ id: grants.id })).length === 1;
    },
    async saveReceipt(receipt: Receipt) { await tx.insert(receipts).values(receipt); },
    async createGrant(ownerUserId: string, connectionId: string, workspaceId: string, command: CreateAgentStandingGrantCommand) {
      const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      await tx.insert(grants).values({ id: randomUUID(), ownerUserId, connectionId, workspaceId,
        clientCommandId: command.clientCommandId, requestFingerprint: fingerprint,
        projectId: command.projectId, operation: command.operation, peerRequestClass: command.peerRequestClass,
        objectId: command.objectId ?? null, maximumUses: command.maximumUses, expiresAt: new Date(command.expiresAt) }).onConflictDoNothing();
      const [row] = await tx.select().from(grants).where(and(eq(grants.connectionId, connectionId), eq(grants.clientCommandId, command.clientCommandId)));
      return row?.requestFingerprint === fingerprint ? grantView(row) : 'IDEMPOTENCY_CONFLICT' as const;
    },
    async listGrants(ownerUserId: string, connectionId: string, page: { limit: number; offset: number }) {
      const where = and(eq(grants.ownerUserId, ownerUserId), eq(grants.connectionId, connectionId));
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(grants).where(where);
      const rows = await tx.select().from(grants).where(where).orderBy(desc(grants.createdAt), desc(grants.id)).limit(page.limit).offset(page.offset);
      return { items: rows.map(grantView), total: count!.total, ...page };
    },
    async liveProjectGrants(ownerUserId: string, connectionId: string, projectId: string, observedAt: Date, page: { limit: number; offset: number }) {
      const where = and(eq(grants.ownerUserId, ownerUserId), eq(grants.connectionId, connectionId), eq(grants.projectId, projectId),
        isNull(grants.revokedAt), gt(grants.expiresAt, observedAt));
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(grants).where(where);
      const rows = await tx.select().from(grants).where(where).orderBy(desc(grants.createdAt), desc(grants.id)).limit(page.limit).offset(page.offset);
      return { items: rows.map((row) => ({ ...grantView(row), remainingUses: Math.max(0, row.maximumUses - row.used) })), total: count!.total, ...page,
        nextOffset: page.offset + page.limit < count!.total ? page.offset + page.limit : null };
    },
    async revokeGrant(ownerUserId: string, connectionId: string, id: string) {
      return (await tx.update(grants).set({ revokedAt: sql`clock_timestamp()`, generation: sql`${grants.generation} + 1` })
        .where(and(eq(grants.id, id), eq(grants.connectionId, connectionId), eq(grants.ownerUserId, ownerUserId), isNull(grants.revokedAt)))
        .returning({ id: grants.id })).length === 1;
    },
    /** The owner's grant on that connection, locked like an execution locks it; another owner's is absent. */
    async lockOwnedGrant(ownerUserId: string, connectionId: string, id: string) {
      const [row] = await tx.select().from(grants).where(and(eq(grants.id, id), eq(grants.connectionId, connectionId),
        eq(grants.ownerUserId, ownerUserId))).for('update');
      return row ?? null;
    },
    /**
     * New limits for a grant the caller locked and checked. The generation stays: receipts keep replaying, and
     * every execution already reads the live limits under the same row lock.
     */
    async narrowGrant(id: string, limits: { maximumUses: number; expiresAt: Date }) {
      const [row] = await tx.update(grants).set({ maximumUses: limits.maximumUses, expiresAt: limits.expiresAt })
        .where(eq(grants.id, id)).returning();
      return grantView(row!);
    },
    /**
     * Native post-state readers are operation-specific, same-project and content-free. `containerId` pins a
     * produced thought to its map or a produced message to the conversation the command targeted.
     */
    async nativePostcondition(workspaceId: string, projectId: string, condition: AgentPostcondition, containerId?: string): Promise<boolean> {
      if (condition.kind === 'cowork.claim_state' || condition.kind === 'cowork.request_state') return false; // #153 supplies its canonical unit/request adapter.
      if (condition.kind === 'map_checkpoint') {
        const table = schema.sketches;
        const [row] = await tx.select({ at: table.updatedAt }).from(table).where(and(eq(table.id, condition.id),
          eq(table.workspaceId, workspaceId), eq(table.projectId, projectId), eq(table.scope, 'project'))).for('share');
        return row?.at.toISOString() === condition.updatedAt;
      }
      if (condition.kind === 'result') {
        const table = schema.projectResults;
        const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, condition.id),
          eq(table.workspaceId, workspaceId), eq(table.projectId, projectId))).for('share');
        return !!row;
      }
      if (condition.kind === 'thought') {
        const table = schema.sketchThoughts;
        const [row] = await tx.select({ version: table.version }).from(table).innerJoin(schema.sketches,
          eq(schema.sketches.id, table.sketchId)).where(and(eq(table.id, condition.id), eq(table.workspaceId, workspaceId),
          eq(schema.sketches.projectId, projectId), eq(schema.sketches.scope, 'project'), containerId ? eq(table.sketchId, containerId) : undefined)).for('share');
        return row?.version === condition.version;
      }
      if (condition.kind === 'material') {
        return await this.sourceVersion(workspaceId, projectId, condition.id) === condition.version;
      }
      if (condition.kind === 'doc') {
        // Still this project's doc, at exactly the version the command produced (a later edit is stale).
        const table = schema.projectMaterials;
        const [row] = await tx.select({ version: table.currentVersion }).from(table).where(and(eq(table.id, condition.id),
          eq(table.workspaceId, workspaceId), eq(table.projectId, projectId), eq(table.kind, 'doc'))).for('share');
        return row?.version === condition.version;
      }
      if (condition.kind === 'message') {
        // A project message is immutable; it must still exist in this project (and the targeted conversation).
        const table = schema.projectMessages;
        const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, condition.id), eq(table.workspaceId, workspaceId),
          eq(table.projectId, projectId), containerId ? eq(table.conversationId, containerId) : undefined)).for('share');
        return !!row;
      }
      const table = condition.kind === 'work' ? schema.projectWorkItems : condition.kind === 'decision' ? schema.projectDecisions : schema.sketches;
      const [row] = await tx.select({ version: table.version }).from(table).where(and(eq(table.id, condition.id),
        eq(table.workspaceId, workspaceId), eq(table.projectId, projectId))).for('share');
      return row?.version === condition.version;
    },
  };
}

export type AgentStoredOutcome = { value: AgentJsonValue; postconditions: AgentPostcondition[] };
