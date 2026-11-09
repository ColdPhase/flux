import { asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** What one request of the server for a run's agent came to; the same words as the table's `outcome`. */
export type StoredWebRead = { url: string; finalUrl: string; title: string | null; outcome: string };

/**
 * The addresses the server sent a request to for a run (#918, #953): written by the tool in the transaction that answers the agent,
 * a page that came back and an address that failed or sent the request on alike, read when the run's answer is committed.
 */
export function personalRunWebReadRows(db: DbExecutor) {
  const w = schema.personalRunWebReads;
  return {
    /** Written before the request goes out (outcome `asked`); returns the row, which `settle` closes when the read ends. */
    async add(runId: string, read: StoredWebRead): Promise<string> {
      const [row] = await db.insert(w).values({ runId, url: read.url.slice(0, 2048), finalUrl: read.finalUrl.slice(0, 2048), title: read.title?.slice(0, 300) ?? null,
        outcome: read.outcome as typeof w.$inferInsert.outcome,
        // The clock's own time and not the transaction's: the hops of one read are written one after another and are listed in the order asked.
        readAt: sql`clock_timestamp()` }).returning({ id: w.id });
      return row!.id;
    },
    /** What became of an address that was asked: its outcome, and for a page that came back its title. */
    async settle(id: string, end: { outcome: string; title?: string | null }) {
      await db.update(w).set({ outcome: end.outcome as typeof w.$inferInsert.outcome, ...(end.title !== undefined ? { title: end.title?.slice(0, 300) ?? null } : {}) }).where(eq(w.id, id));
    },
    /** Every distinct address requested, in the order first requested; an address that came back at any time counts as read. */
    async forRun(runId: string): Promise<{ finalUrl: string; outcome: string }[]> {
      const rows = await db.select({ finalUrl: w.finalUrl, outcome: w.outcome }).from(w).where(eq(w.runId, runId)).orderBy(asc(w.readAt), asc(w.id));
      const first = new Map<string, { finalUrl: string; outcome: string }>();
      for (const row of rows) {
        const earlier = first.get(row.finalUrl);
        if (!earlier) first.set(row.finalUrl, row);
        else if (row.outcome === 'read' && earlier.outcome !== 'read') first.set(row.finalUrl, { ...earlier, outcome: 'read' });
      }
      return [...first.values()];
    },
    /**
     * What one provider answer's built-in web search brought to the run (#954, C-30), already normalized and bounded by core
     * (`boundedWebSearch`). Written by the worker before any tool call of that answer runs.
     */
    async addSearch(runId: string, found: { queries: readonly string[]; results: readonly string[]; cited: readonly string[] }) {
      if (!found.queries.length && !found.results.length && !found.cited.length) return;
      const s = schema.personalRunWebSearches;
      // A row holds at most 10 queries and 100 results and cited addresses (its size check): a response of many searches (#1113, no
      // limit on them) goes in as many rows as it needs, all written in this one statement, so none of it is lost to the row's size.
      const slice = <T>(items: readonly T[], size: number, row: number) => items.slice(row * size, (row + 1) * size);
      const rows = Math.max(Math.ceil(found.queries.length / 10), Math.ceil(found.results.length / 100), Math.ceil(found.cited.length / 100));
      await db.insert(s).values(Array.from({ length: rows }, (_, row) => ({ runId,
        queries: slice(found.queries, 10, row).map((query) => query.slice(0, 300)),
        results: slice(found.results, 100, row).map((address) => address.slice(0, 2048)),
        cited: slice(found.cited, 100, row).map((address) => address.slice(0, 2048)) })));
    },
    /** A search the owner's CLI started (#1065, C-30): written at once, with its query when the CLI shows it then. Its row id fills it in. */
    async startSearch(runId: string, query: string): Promise<string> {
      const s = schema.personalRunWebSearches;
      const [row] = await db.insert(s).values({ runId, queries: query ? [query.slice(0, 300)] : [] }).returning({ id: s.id });
      return row!.id;
    },
    /** The results of that search came back (already normalized and bounded by core), and for Codex its queries. */
    async settleSearch(id: string, results: readonly string[], queries: readonly string[] = []) {
      const s = schema.personalRunWebSearches;
      await db.update(s).set({ results: results.slice(0, 100).map((address) => address.slice(0, 2048)),
        ...(queries.length ? { queries: queries.slice(0, 10).map((query) => query.slice(0, 300)) } : {}) }).where(eq(s.id, id));
    },
    /**
     * The run's searches (#954): their queries and the addresses its answers cited, each once, in the order found. A cited address
     * counts only when one of the run's searches returned it: a citation the model wrote to anything else is not a source.
     */
    async searches(runId: string): Promise<{ queries: string[]; cited: string[] }> {
      const s = schema.personalRunWebSearches;
      const rows = await db.select({ queries: s.queries, results: s.results, cited: s.cited }).from(s).where(eq(s.runId, runId)).orderBy(asc(s.searchedAt), asc(s.id));
      const queries = new Set<string>();
      const results = new Set(rows.flatMap((row) => row.results));
      const cited = new Set<string>();
      for (const row of rows) { for (const query of row.queries) queries.add(query); for (const address of row.cited) if (results.has(address)) cited.add(address); }
      return { queries: [...queries], cited: [...cited] };
    },
    /**
     * Private Flux text the run read (#1065, #1136, C-30), as core keeps it (`keptPrivateText`): its words, compared, and the links written
     * in it. Kept only while the run is in flight: the run's row is share-locked, so a run that ends at the same moment either sees this row
     * and deletes it with the rest (migration 0050's trigger), or this insert sees the run ended and keeps nothing. A text that is only links
     * keeps its links.
     */
    async addPrivateText(runId: string, kept: { body: string; addresses: readonly string[] }) {
      if (!kept.body.trim() && !kept.addresses.length) return;
      const body = kept.body.trim() ? kept.body : '';
      await db.execute(sql`INSERT INTO personal_run_private_texts (run_id, body, addresses)
        SELECT r.id, ${body}, ${sql.param([...kept.addresses])}::text[] FROM personal_runs r
        WHERE r.id = ${runId} AND r.status IN ('reading', 'dispatching') FOR SHARE OF r`);
    },
    /** All the private text the run has read, for the check of an address it asks for. */
    async privateTexts(runId: string): Promise<{ body: string; addresses: string[] }[]> {
      const p = schema.personalRunPrivateTexts;
      return db.select({ body: p.body, addresses: p.addresses }).from(p).where(eq(p.runId, runId));
    },
  };
}
