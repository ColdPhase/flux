import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { openRows, sealFor } from '../sealing.js';

/**
 * Drizzle rows for a project's goals (#520, migration 0099). They satisfy the `ProjectGoalRepository`
 * port of `packages/core/src/project-goals/ports.ts` structurally and make no access decisions: the
 * core use cases authorize first. Names come from the accounts, "Former member" when one is gone.
 */

const g = schema.projectGoals;
const setter = alias(schema.authUsers, 'goal_setter');
const reacher = alias(schema.authUsers, 'goal_reacher');

export interface ProjectGoalRow {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  setBy: string;
  setByName: string | null;
  setAt: Date;
  reachedAt: Date | null;
  reachedBy: string | null;
  reachedByName: string | null;
}

const columns = {
  id: g.id, workspaceId: g.workspaceId, projectId: g.projectId, title: g.title,
  setBy: g.setBy, setByName: setter.name, setAt: g.setAt, reachedAt: g.reachedAt, reachedBy: g.reachedBy, reachedByName: reacher.name,
};

export function projectGoalRows(db: DbExecutor) {
  const named = () => db.select(columns).from(g).leftJoin(setter, eq(setter.id, g.setBy)).leftJoin(reacher, eq(reacher.id, g.reachedBy));
  // F-030: titles are sealed in an encrypted workspace; every read opens them.
  const open = (rows: ProjectGoalRow[]) => openRows(db, 'project_goals', rows);
  const one = async (id: string): Promise<ProjectGoalRow> => (await open(await named().where(eq(g.id, id))))[0]!;
  return {
    /** Serializes goal changes of one project and bumps nothing; taken before the access decision. */
    async lockProject(projectId: string): Promise<void> {
      await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('no key update');
    },

    async projectVersion(projectId: string): Promise<number> {
      const [row] = await db.select({ version: schema.projects.version }).from(schema.projects).where(eq(schema.projects.id, projectId));
      return row!.version;
    },

    /** A goal change is a change of the project: its version moves on (the next If-Match). */
    async bumpProject(projectId: string): Promise<number> {
      const [row] = await db.update(schema.projects).set({ version: sql`${schema.projects.version} + 1`, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId)).returning({ version: schema.projects.version });
      return row!.version;
    },

    async current(projectId: string): Promise<ProjectGoalRow | null> {
      return (await open(await named().where(and(eq(g.projectId, projectId), isNull(g.reachedAt)))))[0] ?? null;
    },

    async latestReached(projectId: string): Promise<ProjectGoalRow | null> {
      return (await open(await named().where(and(eq(g.projectId, projectId), isNotNull(g.reachedAt))).orderBy(desc(g.reachedAt), desc(g.id)).limit(1)))[0] ?? null;
    },

    /** The goal each project shows: its current goal, or else its most recently reached one. */
    async shown(projectIds: readonly string[]): Promise<Map<string, ProjectGoalRow>> {
      if (!projectIds.length) return new Map();
      const rows = await open(await named().where(inArray(g.projectId, [...projectIds]))
        .orderBy(g.projectId, sql`${g.reachedAt} IS NOT NULL`, desc(g.reachedAt), desc(g.id)));
      const shown = new Map<string, ProjectGoalRow>();
      for (const row of rows) if (!shown.has(row.projectId)) shown.set(row.projectId, row);
      return shown;
    },

    /** Newest first: the current goal, then reached goals by when they were reached. */
    async list(projectId: string, limit: number): Promise<ProjectGoalRow[]> {
      return open(await named().where(eq(g.projectId, projectId))
        .orderBy(sql`${g.reachedAt} IS NOT NULL`, desc(g.reachedAt), desc(g.setAt), desc(g.id)).limit(limit));
    },

    async insert(goal: { id: string; workspaceId: string; projectId: string; title: string; setBy: string }): Promise<ProjectGoalRow> {
      await db.insert(g).values(await sealFor(db, 'project_goals', goal.workspaceId, goal));
      return one(goal.id);
    },

    async updateTitle(id: string, title: string): Promise<ProjectGoalRow> {
      const [row] = await db.select({ workspaceId: g.workspaceId }).from(g).where(eq(g.id, id));
      await db.update(g).set(await sealFor(db, 'project_goals', row!.workspaceId, { title }, { id })).where(eq(g.id, id));
      return one(id);
    },

    async remove(id: string): Promise<void> {
      await db.delete(g).where(and(eq(g.id, id), isNull(g.reachedAt)));
    },

    async markReached(id: string, by: string): Promise<ProjectGoalRow> {
      await db.update(g).set({ reachedAt: sql`now()`, reachedBy: by }).where(and(eq(g.id, id), isNull(g.reachedAt)));
      return one(id);
    },

    async reopen(id: string): Promise<ProjectGoalRow> {
      await db.update(g).set({ reachedAt: null, reachedBy: null }).where(eq(g.id, id));
      return one(id);
    },
  };
}
