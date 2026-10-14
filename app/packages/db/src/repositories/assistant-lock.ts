import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/** Shared writer order for assistant enablement, project membership and either owner settings surface. */
export async function lockAssistantOwner(tx: DbExecutor, ownerUserId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'assistant-owner:' + ownerUserId}, 0))`);
}
