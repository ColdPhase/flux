import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for approved project policies (#160, migration 0044). Every revision stays
 * unchanged; the newest is the approved one. Core decides who may publish and checks the
 * revision the manager saw; a concurrent publish of the same revision fails on the primary key.
 */
const p = schema.agentProjectPolicies;

export interface AgentPolicyRow {
  projectId: string;
  revision: number;
  scope: string;
  priorities: string;
  reviewCriteria: string;
  allowedWork: string;
  digest: string;
  publishedAt: Date;
  publishedBy: { id: string; name: string | null };
}

const columns = {
  projectId: p.projectId, revision: p.revision, scope: p.scope, priorities: p.priorities, reviewCriteria: p.reviewCriteria,
  allowedWork: p.allowedWork, digest: p.digest, publishedAt: p.publishedAt, publishedById: p.publishedByUserId, publishedByName: schema.authUsers.name,
};
const view = ({ publishedById, publishedByName, ...row }: { publishedById: string; publishedByName: string | null } & Omit<AgentPolicyRow, 'publishedBy'>): AgentPolicyRow =>
  ({ ...row, publishedBy: { id: publishedById, name: publishedByName } });

export function agentPolicyRows(db: DbExecutor) {
  const select = () => db.select(columns).from(p).leftJoin(schema.authUsers, eq(schema.authUsers.id, p.publishedByUserId));
  return {
    async current(projectId: string): Promise<AgentPolicyRow | null> {
      const [row] = await select().where(eq(p.projectId, projectId)).orderBy(desc(p.revision)).limit(1);
      return row ? view(row) : null;
    },
    async revision(projectId: string, revision: number): Promise<AgentPolicyRow | null> {
      const [row] = await select().where(and(eq(p.projectId, projectId), eq(p.revision, revision)));
      return row ? view(row) : null;
    },
    /** Inserts one revision; false when that revision already exists (a concurrent publish won). */
    async insert(row: Omit<AgentPolicyRow, 'publishedAt' | 'publishedBy'> & { publishedByUserId: string }): Promise<boolean> {
      const inserted = await db.insert(p).values(row).onConflictDoNothing().returning({ revision: p.revision });
      return inserted.length > 0;
    },
  };
}
