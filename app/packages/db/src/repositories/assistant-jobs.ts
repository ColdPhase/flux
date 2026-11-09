import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AssistantJobSchedule } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { companyGuestSql, isCompanyGuest } from './access.js';

// Drizzle rows of an agent's schedules (migration 0024, F-036 AG-9, #858). They satisfy `AssistantJobRepository` of
// packages/core/src/assistant structurally and make no access decisions: the core use cases ask the access policy first.

const j = schema.assistantJobs;
const jr = schema.assistantJobRuns;
type JobRow = typeof j.$inferSelect;
type JobRunRow = typeof jr.$inferSelect;
type NewJobRow = Pick<JobRow, 'id' | 'workspaceId' | 'ownerUserId' | 'agentId' | 'title' | 'text' | 'given' | 'timeZone' | 'enabled' | 'prepared' | 'nextRunAt'>
  & { schedule: AssistantJobSchedule; preparedRunId?: string | null };
type JobChanges = Partial<Pick<JobRow, 'title' | 'text' | 'given' | 'timeZone' | 'enabled' | 'prepared' | 'nextRunAt' | 'lastRunAt' | 'deletedAt'>> & { schedule?: AssistantJobSchedule };

const toJob = (row: JobRow) => ({ ...row, schedule: row.schedule as unknown as AssistantJobSchedule });

export function assistantJobRows(db: DbExecutor) {
  /**
   * `visibleToOwner`: the lookup of the owner's own screen. A guest of the company has none: their schedules are kept but hidden and
   * refused until they are a member again (#1059, C-50). The worker's lookups (settling a firing, the tick) leave it off and still find them.
   */
  async function find(id: string, options: { lock?: boolean; visibleToOwner?: boolean } = {}) {
    const query = db.select().from(j).where(and(eq(j.id, id), options.visibleToOwner ? sql`NOT ${companyGuestSql(j.ownerUserId)}` : undefined));
    const [row] = options.lock ? await query.for('update') : await query;
    return row ? toJob(row) : null;
  }
  return {
    /** An agent's schedules, oldest first; not the deleted ones, and none while the owner is a guest of the company (#1059). */
    async list(ownerUserId: string, agentId: string) {
      const rows = await db.select().from(j)
        .where(and(eq(j.ownerUserId, ownerUserId), eq(j.agentId, agentId), isNull(j.deletedAt), sql`NOT ${companyGuestSql(j.ownerUserId)}`)).orderBy(asc(j.createdAt), asc(j.id));
      return rows.map(toJob);
    },
    find,
    /** Whether the owner is a guest of the company now (a plain read: the tick is the only caller, and it moves a schedule on either way). */
    ownerIsGuest: (ownerUserId: string) => isCompanyGuest(db, ownerUserId),
    /**
     * Holds an agent's schedule rows for the rest of the transaction. Deleting an agent takes them first, then the owner's lock: the order a firing
     * already has (it holds its schedule row, then takes the owner's lock in `fireJob`), so the two cannot wait on each other.
     */
    async lockForAgent(ownerUserId: string, agentId: string) {
      await db.select({ id: j.id }).from(j).where(and(eq(j.ownerUserId, ownerUserId), eq(j.agentId, agentId))).orderBy(asc(j.id)).for('update');
    },
    async countActive(ownerUserId: string) {
      const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(j).where(and(eq(j.ownerUserId, ownerUserId), isNull(j.deletedAt)));
      return row?.total ?? 0;
    },
    async insert(job: NewJobRow) {
      const [row] = await db.insert(j).values({ ...job, scheduleKind: job.schedule.kind, schedule: job.schedule as unknown as Record<string, unknown> }).returning();
      return toJob(row!);
    },
    async update(id: string, changes: JobChanges) {
      const { schedule, ...rest } = changes;
      const [row] = await db.update(j).set({
        ...rest, ...(schedule ? { schedule: schedule as unknown as Record<string, unknown>, scheduleKind: schedule.kind } : {}),
        version: sql`${j.version} + 1`, updatedAt: new Date(),
      }).where(eq(j.id, id)).returning();
      return toJob(row!);
    },
    async lockDue(now: Date) {
      const result = await db.execute(sql`SELECT id FROM assistant_jobs WHERE enabled AND deleted_at IS NULL AND next_run_at <= ${now}
        ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const id = (result.rows[0] as { id: string } | undefined)?.id;
      if (!id) return null;
      const [row] = await db.select().from(j).where(eq(j.id, id));
      return row ? toJob(row) : null;
    },
    async purgeDeleted(before: Date) {
      return (await db.delete(j).where(and(sql`${j.deletedAt} IS NOT NULL`, lte(j.deletedAt, before))).returning({ id: j.id })).length;
    },

    async insertRun(run: { id: string; jobId: string; ownerUserId: string; firedAt: Date; firedBy: 'schedule' | 'now'; state: 'running' | 'done' | 'skipped' | 'failed'; resultLine: string; finishedAt?: Date | null }) {
      const [row] = await db.insert(jr).values({ ...run, finishedAt: run.finishedAt ?? (run.state === 'running' ? null : new Date()) }).onConflictDoNothing().returning();
      return row ?? null;
    },
    async findRun(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(jr).where(eq(jr.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ?? null;
    },
    async runExists(jobId: string, firedAt: Date, firedBy: 'schedule' | 'now') {
      const [row] = await db.select({ id: jr.id }).from(jr).where(and(eq(jr.jobId, jobId), eq(jr.firedAt, firedAt), eq(jr.firedBy, firedBy)));
      return Boolean(row);
    },
    async updateRun(id: string, changes: Partial<Pick<JobRunRow, 'runId' | 'state' | 'resultLine' | 'finishedAt'>>) {
      const [row] = await db.update(jr).set(changes).where(eq(jr.id, id)).returning();
      return row!;
    },
    async runsOf(jobId: string, limit: number) {
      return db.select().from(jr).where(eq(jr.jobId, jobId)).orderBy(desc(jr.firedAt), desc(jr.id)).limit(limit);
    },
    async lastRuns(jobIds: string[]) {
      if (!jobIds.length) return new Map<string, JobRunRow>();
      const rows = await db.execute(sql`SELECT DISTINCT ON (job_id) * FROM assistant_job_runs WHERE job_id IN (${sql.join(jobIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY job_id, fired_at DESC, id DESC`);
      return new Map((rows.rows as Record<string, unknown>[]).map((raw) => {
        const row: JobRunRow = { id: raw.id as string, jobId: raw.job_id as string, ownerUserId: raw.owner_user_id as string, firedAt: new Date(raw.fired_at as string),
          firedBy: raw.fired_by as 'schedule' | 'now', runId: (raw.run_id as string | null) ?? null, state: raw.state as JobRunRow['state'], resultLine: raw.result_line as string,
          startedAt: new Date(raw.started_at as string), finishedAt: raw.finished_at ? new Date(raw.finished_at as string) : null };
        return [row.jobId, row] as const;
      }));
    },
    async running(jobIds: string[]) {
      if (!jobIds.length) return new Set<string>();
      const rows = await db.select({ jobId: jr.jobId }).from(jr).where(and(inArray(jr.jobId, jobIds), eq(jr.state, 'running')));
      return new Set(rows.map((row) => row.jobId));
    },
    async openRuns(limit: number, ownerUserId?: string) {
      return db.select().from(jr).where(and(eq(jr.state, 'running'), ownerUserId ? eq(jr.ownerUserId, ownerUserId) : undefined)).orderBy(asc(jr.startedAt), asc(jr.id)).limit(limit);
    },
    async trimRuns(jobId: string, keep: number) {
      await db.execute(sql`DELETE FROM assistant_job_runs WHERE job_id = ${jobId} AND state <> 'running' AND id NOT IN
        (SELECT id FROM assistant_job_runs WHERE job_id = ${jobId} ORDER BY fired_at DESC, id DESC LIMIT ${keep})`);
    },
    async noteVersion(ownerUserId: string, accountKey: string) {
      const [row] = await db.select({ version: schema.assistantBackgroundNotes.noteVersion }).from(schema.assistantBackgroundNotes)
        .where(and(eq(schema.assistantBackgroundNotes.ownerUserId, ownerUserId), eq(schema.assistantBackgroundNotes.accountKey, accountKey)));
      return row?.version ?? null;
    },
    async acceptNote(ownerUserId: string, accountKey: string, version: string) {
      await db.insert(schema.assistantBackgroundNotes).values({ ownerUserId, accountKey, noteVersion: version })
        .onConflictDoUpdate({ target: [schema.assistantBackgroundNotes.ownerUserId, schema.assistantBackgroundNotes.accountKey], set: { noteVersion: version, acceptedAt: new Date() } });
    },
  };
}
