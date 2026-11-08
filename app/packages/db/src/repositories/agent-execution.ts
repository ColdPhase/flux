import { and, eq, sql } from 'drizzle-orm';
import type { AgentPostcondition } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Receipt = typeof schema.agentCommandReceipts.$inferInsert;
const runtime = schema.agentRuntimeSessions;
const receipts = schema.agentCommandReceipts;
/** Rows/locks only. The caller owns the open transaction and supplies core authorization. */
export function agentExecutionRows(tx: DbExecutor) {
  return {
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
    async saveReceipt(receipt: Receipt) { await tx.insert(receipts).values(receipt); },
    /**
     * Native post-state readers are operation-specific, same-project and content-free. `containerId` pins a
     * produced thought to its map or a produced message to the conversation the command targeted.
     */
    async nativePostcondition(workspaceId: string, projectId: string, condition: AgentPostcondition, containerId?: string): Promise<boolean> {
      if (condition.kind === 'cowork.claim_state' || condition.kind === 'cowork.unit_state')
        return false; // #153 supplies its canonical unit/request adapter.
      if (condition.kind === 'map_checkpoint') {
        const table = schema.sketches;
        const [row] = await tx.select({ at: table.updatedAt }).from(table).where(and(eq(table.id, condition.id),
          eq(table.workspaceId, workspaceId), eq(table.projectId, projectId), eq(table.scope, 'project'))).for('share');
        return row?.at.toISOString() === condition.updatedAt;
      }
      if (condition.kind === 'doc_removed') {
        // The page is no longer a doc of this project (#941).
        const table = schema.projectMaterials;
        const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, condition.id),
          eq(table.workspaceId, workspaceId), eq(table.projectId, projectId), eq(table.kind, 'doc'))).for('share');
        return !row;
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
