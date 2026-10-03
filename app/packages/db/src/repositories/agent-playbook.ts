import { eq, sql } from 'drizzle-orm';
import type { AgentInstructionAcknowledgment, AgentInstructionReference } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

const acks = schema.agentPlaybookAcknowledgments;
const view = (row: typeof acks.$inferSelect): AgentInstructionAcknowledgment =>
  ({ bundleId: row.bundleId, version: row.version, digest: row.digest, acknowledgedAt: row.acknowledgedAt.toISOString() });

/** The playbook a client reported loading for one server-issued runtime session (#160). */
export function agentPlaybookRows(db: DbExecutor) {
  return {
    async acknowledgment(runtimeSessionId: string): Promise<AgentInstructionAcknowledgment | null> {
      const [row] = await db.select().from(acks).where(eq(acks.runtimeSessionId, runtimeSessionId));
      return row ? view(row) : null;
    },
    /** Re-acknowledging the same bundle keeps its first time; a newer bundle replaces it. */
    async acknowledge(runtimeSessionId: string, reference: Pick<AgentInstructionReference, 'bundleId' | 'version' | 'digest'>) {
      const [row] = await db.insert(acks).values({ runtimeSessionId, ...reference }).onConflictDoUpdate({
        target: acks.runtimeSessionId,
        set: { bundleId: reference.bundleId, version: reference.version, digest: reference.digest,
          acknowledgedAt: sql`CASE WHEN ${acks.digest} = excluded.digest THEN ${acks.acknowledgedAt} ELSE excluded.acknowledged_at END` },
      }).returning();
      return view(row!);
    },
  };
}
