import { and, eq, ne } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * A person's own time zone (#1168, C-57): the IANA zone of the browser they use Flux in, which the web app saves whenever it is a different
 * one. Their schedules run in it and their agents' clock reads in it. UTC until a browser has said. The caller checks the zone is a real one.
 */
const u = schema.authUsers;

export function personTimeZones(db: DbExecutor) {
  return {
    async get(userId: string): Promise<string> {
      const [row] = await db.select({ zone: u.timeZone }).from(u).where(eq(u.id, userId));
      return row?.zone ?? 'UTC';
    },
    /** Writes only a different zone: a browser that says the same one again changes no row. */
    async set(userId: string, timeZone: string): Promise<void> {
      await db.update(u).set({ timeZone }).where(and(eq(u.id, userId), ne(u.timeZone, timeZone)));
    },
  };
}
