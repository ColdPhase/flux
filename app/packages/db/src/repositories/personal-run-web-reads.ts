import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** The pages a run read on the web (#918): written by the tool in the transaction that returns the page, read when the run's answer is committed. */
export function personalRunWebReadRows(db: DbExecutor) {
  const w = schema.personalRunWebReads;
  return {
    async add(runId: string, read: { url: string; finalUrl: string; title: string | null }) {
      await db.insert(w).values({ runId, url: read.url.slice(0, 2048), finalUrl: read.finalUrl.slice(0, 2048), title: read.title?.slice(0, 300) ?? null });
    },
    /** The pages of the run, each once (by where it ended), in the order they were first read. */
    async forRun(runId: string): Promise<{ finalUrl: string; title: string | null }[]> {
      const rows = await db.select({ finalUrl: w.finalUrl, title: w.title }).from(w).where(eq(w.runId, runId)).orderBy(asc(w.readAt), asc(w.id));
      const seen = new Set<string>();
      return rows.filter((row) => (seen.has(row.finalUrl) ? false : (seen.add(row.finalUrl), true)));
    },
  };
}
