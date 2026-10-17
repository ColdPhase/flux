import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AssistantJobSchedule } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { assistantChangeRows } from './assistant-changes.js';
import { notificationRows } from './push.js';

// Drizzle rows of "On a schedule" and the morning summary written by the assistant (migration 0109, F-027 A8 #408). They
// satisfy `AssistantJobRepository` and `AssistantSummaryRepository` of packages/core/src/assistant structurally and make no
// access decisions: the core use cases ask the access policy first.

const j = schema.assistantJobs;
const jr = schema.assistantJobRuns;
const runs = schema.personalRuns;
type JobRow = typeof j.$inferSelect;
type JobRunRow = typeof jr.$inferSelect;
type NewJobRow = Pick<JobRow, 'id' | 'workspaceId' | 'ownerUserId' | 'projectId' | 'title' | 'text' | 'timeZone' | 'conversationId' | 'postToConversation' | 'enabled' | 'prepared' | 'nextRunAt'>
  & { schedule: AssistantJobSchedule; preparedRunId?: string | null };
type JobChanges = Partial<Pick<JobRow, 'projectId' | 'title' | 'text' | 'timeZone' | 'conversationId' | 'postToConversation' | 'enabled' | 'prepared' | 'pausedReason'
  | 'nextRunAt' | 'lastRunAt' | 'failureStreak' | 'deletedAt'>> & { schedule?: AssistantJobSchedule };

const toJob = (row: JobRow) => ({ ...row, schedule: row.schedule as unknown as AssistantJobSchedule });
const startOfDay = (timeZone: string) => sql`(date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})`;

export function assistantJobRows(db: DbExecutor) {
  async function find(id: string, options: { lock?: boolean } = {}) {
    const query = db.select({ job: j, projectName: schema.projects.name }).from(j)
      .innerJoin(schema.projects, and(eq(schema.projects.workspaceId, j.workspaceId), eq(schema.projects.id, j.projectId))).where(eq(j.id, id));
    const [row] = options.lock ? await query.for('update', { of: j }) : await query;
    return row ? { ...toJob(row.job), projectName: row.projectName } : null;
  }
  return {
    async list(ownerUserId: string, workspaceId: string) {
      const rows = await db.select({ job: j, projectName: schema.projects.name }).from(j)
        .innerJoin(schema.projects, and(eq(schema.projects.workspaceId, j.workspaceId), eq(schema.projects.id, j.projectId)))
        .where(and(eq(j.ownerUserId, ownerUserId), eq(j.workspaceId, workspaceId), isNull(j.deletedAt))).orderBy(asc(j.createdAt), asc(j.id));
      return rows.map((row) => ({ ...toJob(row.job), projectName: row.projectName }));
    },
    find,
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
    async updateRun(id: string, changes: Partial<Pick<JobRunRow, 'runId' | 'state' | 'resultLine' | 'needsYou' | 'finishedAt'>>) {
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
          needsYou: raw.needs_you as boolean, startedAt: new Date(raw.started_at as string), finishedAt: raw.finished_at ? new Date(raw.finished_at as string) : null };
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
    async runsTodayForJob(jobId: string, timeZone: string) {
      const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(jr)
        .where(and(eq(jr.jobId, jobId), sql`${jr.state} <> 'skipped'`, sql`${jr.startedAt} >= ${startOfDay(timeZone)}`));
      return row?.total ?? 0;
    },
    async backgroundRunsToday(ownerUserId: string, timeZone: string) {
      const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(runs)
        .where(and(eq(runs.ownerUserId, ownerUserId), inArray(runs.kind, ['scheduled', 'morning_summary']), sql`${runs.createdAt} >= ${startOfDay(timeZone)}`));
      return row?.total ?? 0;
    },
    async backgroundLimit(ownerUserId: string, workspaceId: string) {
      const [row] = await db.select({ limit: schema.assistantSettings.backgroundRunsPerDay }).from(schema.assistantSettings)
        .where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId), eq(schema.assistantSettings.workspaceId, workspaceId)));
      return row?.limit ?? null;
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

    async settledFacts(runId: string) {
      const c = schema.assistantChanges;
      const [row] = await db.select({
        applied: sql<number>`count(*) FILTER (WHERE ${c.state} IN ('applied', 'applied_after_wait'))::int`,
        waiting: sql<number>`count(*) FILTER (WHERE ${c.state} = 'waiting')::int`,
      }).from(c).where(eq(c.runId, runId));
      return { appliedChanges: row?.applied ?? 0, waitingChanges: row?.waiting ?? 0 };
    },
    promoteWaiting: (runId: string, now: Date) => assistantChangeRows(db).promote(runId, now),

    /** One Inbox item for the owner about their own assistant (a paused schedule), about a project they can read. */
    async notify(ownerUserId: string, projectId: string, title: string, body: string, url: string) {
      const [project] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, projectId));
      if (!project) throw new Error('Project not found');
      const id = randomUUID();
      await notificationRows(db).insert({ id, userId: ownerUserId, source: { workspaceId: project.workspaceId, type: 'project', id: projectId }, title, body, url });
      return id;
    },

    /** The project's latest conversation of people: where a silent run is anchored. */
    async anchorConversation(projectId: string) {
      const c = schema.projectConversations;
      const [row] = await db.select({ id: c.id }).from(c).where(and(eq(c.projectId, projectId), eq(c.space, 'people'))).orderBy(desc(c.createdAt), desc(c.id)).limit(1);
      return row?.id ?? null;
    },
    async conversationInProject(projectId: string, conversationId: string) {
      const c = schema.projectConversations;
      const [row] = await db.select({ id: c.id }).from(c).where(and(eq(c.id, conversationId), eq(c.projectId, projectId), eq(c.space, 'people')));
      return Boolean(row);
    },
  };
}

const s = schema.assistantMorningSummaries;
type SummaryDbRow = typeof s.$inferSelect;
const toSummary = (row: SummaryDbRow) => ({ ownerUserId: row.ownerUserId, day: row.day, runId: row.runId, state: row.state, line: row.line, createdAt: row.createdAt });

/** The morning summary the assistant writes (migration 0109): its day row, the person's name, notification titles and anchors. */
export function assistantSummaryRows(db: DbExecutor) {
  return {
    async create(row: { ownerUserId: string; day: string; runId: string }) {
      const inserted = await db.insert(s).values({ ...row, state: 'writing' }).onConflictDoNothing().returning({ day: s.day });
      return inserted.length > 0;
    },
    async writing(limit: number) {
      return (await db.select().from(s).where(eq(s.state, 'writing')).orderBy(asc(s.createdAt), asc(s.day)).limit(limit)).map(toSummary);
    },
    async lock(ownerUserId: string, day: string) {
      const result = await db.execute(sql`SELECT owner_user_id FROM assistant_morning_summaries WHERE owner_user_id = ${ownerUserId} AND day = ${day}::date AND state = 'writing' FOR UPDATE SKIP LOCKED`);
      if (!result.rows.length) return null;
      const [row] = await db.select().from(s).where(and(eq(s.ownerUserId, ownerUserId), sql`${s.day} = ${day}::date`));
      return row ? toSummary(row) : null;
    },
    async settle(ownerUserId: string, day: string, state: 'written' | 'plain', line: string | null, now: Date) {
      await db.update(s).set({ state, line, settledAt: now }).where(and(eq(s.ownerUserId, ownerUserId), sql`${s.day} = ${day}::date`));
    },
    async today(ownerUserId: string, day: string) {
      const [row] = await db.select().from(s).where(and(eq(s.ownerUserId, ownerUserId), sql`${s.day} = ${day}::date`));
      return row ? toSummary(row) : null;
    },
    async firstName(ownerUserId: string) {
      const [row] = await db.select({ name: schema.authUsers.name }).from(schema.authUsers).where(eq(schema.authUsers.id, ownerUserId));
      return (row?.name ?? '').trim().split(/\s+/)[0] || 'there';
    },
    async titles(ids: string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.notifications.id, title: schema.notifications.title }).from(schema.notifications).where(inArray(schema.notifications.id, ids));
      return new Map(rows.map((row) => [row.id, row.title]));
    },
    async anchors(ownerUserId: string, workspaceId: string, limit: number) {
      const result = await db.execute(sql`SELECT DISTINCT ON (c.project_id) c.project_id, c.id AS conversation_id, c.created_at
        FROM project_conversations c
        WHERE c.workspace_id = ${workspaceId} AND c.space = 'people'
        ORDER BY c.project_id, c.created_at DESC LIMIT ${limit * 4}`);
      return (result.rows as { project_id: string; conversation_id: string; created_at: Date | string }[])
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map((row) => ({ projectId: row.project_id, conversationId: row.conversation_id })).slice(0, limit);
    },
  };
}

