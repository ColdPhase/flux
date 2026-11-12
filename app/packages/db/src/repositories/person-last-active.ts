import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * When a person was last active, and whether they let others see it (#1225, C-58). `touch` is the only writer of the time and it writes at
 * most once a minute for a person whatever calls it (the one-minute condition is in the statement, so a second API process cannot write more),
 * and never for someone who turned the switch off. Turning it off erases the time held.
 */
const u = schema.authUsers;

export function personLastActive(db: DbExecutor) {
  return {
    /** Writes the time now, unless one younger than a minute is held or the person turned it off. True when it wrote. */
    async touch(userId: string): Promise<boolean> {
      const written = await db.update(u).set({ lastActiveAt: sql`now()` })
        .where(and(eq(u.id, userId), eq(u.showLastActive, true), or(isNull(u.lastActiveAt), lt(u.lastActiveAt, sql`now() - interval '1 minute'`))))
        .returning({ id: u.id });
      return written.length > 0;
    },
    async shows(userId: string): Promise<boolean> {
      const [row] = await db.select({ show: u.showLastActive }).from(u).where(eq(u.id, userId));
      return row?.show ?? true;
    },
    /** Off erases the time held; on starts it from now, because the person is using Flux as they turn it on. */
    async setShows(userId: string, show: boolean): Promise<void> {
      await db.update(u).set(show ? { showLastActive: true, lastActiveAt: sql`now()` } : { showLastActive: false, lastActiveAt: null }).where(eq(u.id, userId));
    },
  };
}
