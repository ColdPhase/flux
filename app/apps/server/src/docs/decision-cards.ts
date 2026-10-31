import type { FastifyInstance } from 'fastify';
import { createDocUseCases, type DecisionCardConversion } from '@flux/core';
import { sealResolverScope, sql, type Database, type DbExecutor } from '@flux/db';
import { withTaskUseErrors } from '../work/task-use-errors.js';
import { bearerMatches } from '../fixture/index.js';
import { docPorts } from './adapters.js';

/**
 * F-034 migration (#763 E1): the copied `## Decision:` sections that "Add to docs" wrote before become live decision
 * cards, once per doc. Each doc is converted in its own transaction with its row lock, and recorded in
 * `doc_decision_card_migrations` in the same transaction, so two API processes never convert one doc twice. A doc
 * whose shared working copy holds unsaved typing, or whose encrypted workspace is locked here, is not recorded and is
 * tried again by a later sweep. Any other failure is logged with its code only (never text) and recorded in
 * `doc_decision_card_failures`: the doc waits 10 minutes, doubling each time, and the same code five times in a row
 * stops its retries. Core decides what converts (`convertDecisionSections`); nothing else is rewritten.
 * `restoreDecisionCards` is the reversal.
 */

const PAGE = 200;
const SWEEP_MS = 600_000;

export interface DecisionCardSweep { converted: number; unchanged: number; skipped: number }

type Log = Pick<FastifyInstance['log'], 'warn'>;
const GIVE_UP_AFTER = 5;
const codeOf = (error: unknown) => {
  const raw = (error as { code?: unknown } | null)?.code ?? (error as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : 'ERROR';
};
const useCases = (executor: DbExecutor) => createDocUseCases({ run: (work) => withTaskUseErrors(() => work(docPorts(executor))) });

/** Records a failed attempt: doubling waits from 10 minutes; the same code `GIVE_UP_AFTER` times in a row stops retries. */
async function recordFailure(db: Database, docId: string, code: string) {
  const rows = (await db.execute(sql`INSERT INTO doc_decision_card_failures (doc_id, workspace_id, code, attempts, retry_after)
      SELECT m.id, m.workspace_id, ${code}, 1, now() + interval '10 minutes' FROM project_materials m WHERE m.id = ${docId}::uuid
    ON CONFLICT (doc_id) DO UPDATE SET
      attempts = CASE WHEN doc_decision_card_failures.code = EXCLUDED.code THEN doc_decision_card_failures.attempts + 1 ELSE 1 END,
      code = EXCLUDED.code, failed_at = now(),
      retry_after = CASE WHEN doc_decision_card_failures.code = EXCLUDED.code AND doc_decision_card_failures.attempts + 1 >= ${GIVE_UP_AFTER} THEN 'infinity'::timestamptz
        ELSE now() + interval '10 minutes' * power(2, CASE WHEN doc_decision_card_failures.code = EXCLUDED.code THEN doc_decision_card_failures.attempts ELSE 0 END) END
    RETURNING attempts`)).rows as { attempts: number }[];
  return rows[0]?.attempts ?? 0;
}

async function convertOne(db: Database, docId: string, log: Log, inject?: string): Promise<DecisionCardConversion | 'skipped'> {
  try {
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as DbExecutor;
      const done = await executor.execute(sql`SELECT 1 FROM doc_decision_card_migrations WHERE doc_id = ${docId}::uuid`);
      if (done.rows.length) return { status: 'unchanged', converted: 0, kept: 0 } as DecisionCardConversion;
      if (inject) throw Object.assign(new Error('Injected conversion failure'), { code: inject }); // test route only
      const outcome = await useCases(executor).convertDecisionSections(docId);
      if (outcome.status === 'busy' || outcome.status === 'gone') return outcome;
      await executor.execute(sql`INSERT INTO doc_decision_card_migrations (doc_id, workspace_id, from_version, to_version, converted, kept)
        SELECT m.id, m.workspace_id, ${outcome.fromVersion!}, ${outcome.toVersion ?? null}, ${outcome.converted}, ${outcome.kept}
        FROM project_materials m WHERE m.id = ${docId}::uuid ON CONFLICT (doc_id) DO NOTHING`);
      await executor.execute(sql`DELETE FROM doc_decision_card_failures WHERE doc_id = ${docId}::uuid`);
      return outcome;
    });
    return outcome;
  } catch (error) {
    const code = codeOf(error);
    // A locked encrypted workspace simply waits for its unlock; it is not a failure of the doc.
    if (code === 'WORKSPACE_LOCKED') return 'skipped';
    const attempts = await recordFailure(db, docId, code).catch(() => 0);
    log.warn({ docId, code, attempts, givenUp: attempts >= GIVE_UP_AFTER }, 'Wiki decision cards: a doc was not converted');
    return 'skipped';
  }
}

/** Converts the named docs only (the test route's way to stay inside its own docs). */
export async function convertDecisionCardDocs(db: Database, ids: readonly string[], log: Log, inject?: string): Promise<DecisionCardSweep> {
  const tally: DecisionCardSweep = { converted: 0, unchanged: 0, skipped: 0 };
  for (const id of ids) count(tally, await convertOne(db, id, log, inject));
  return tally;
}

function count(tally: DecisionCardSweep, outcome: DecisionCardConversion | 'skipped') {
  if (outcome === 'skipped' || outcome.status === 'busy' || outcome.status === 'gone') tally.skipped++;
  else if (outcome.status === 'converted') tally.converted++;
  else tally.unchanged++;
}

/** One pass over every doc not converted yet and not waiting after a failure, in id order. */
export async function sweepDecisionCards(db: Database, log: Log): Promise<DecisionCardSweep> {
  const tally: DecisionCardSweep = { converted: 0, unchanged: 0, skipped: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = (await db.execute(sql`SELECT m.id FROM project_materials m WHERE m.kind = 'doc' AND m.id > ${after}::uuid
      AND NOT EXISTS (SELECT 1 FROM doc_decision_card_migrations x WHERE x.doc_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM doc_decision_card_failures f WHERE f.doc_id = m.id AND f.retry_after > now()) ORDER BY m.id LIMIT ${PAGE}`)).rows as { id: string }[];
    for (const { id } of page) count(tally, await convertOne(db, id, log));
    if (page.length < PAGE) return tally;
    after = page[page.length - 1]!.id;
  }
}

export interface DecisionCardRestore { restored: number; changed: number; skipped: number }

/**
 * The reversal: for each converted doc (all of them, or `docIds`), brings back the copied text of `from_version` as a
 * new version while the doc is still at `to_version`, and marks it `restored_version` so the sweep never converts it
 * again. A doc edited since is left to its history's Restore; one with unsaved shared typing is tried by a later call.
 */
export async function restoreDecisionCards(db: Database, docIds?: readonly string[]): Promise<DecisionCardRestore> {
  const tally: DecisionCardRestore = { restored: 0, changed: 0, skipped: 0 };
  const rows = (await db.execute(docIds
    ? sql`SELECT doc_id, from_version, to_version FROM doc_decision_card_migrations WHERE to_version IS NOT NULL AND restored_version IS NULL AND doc_id = ANY(${`{${docIds.join(',')}}`}::uuid[])`
    : sql`SELECT doc_id, from_version, to_version FROM doc_decision_card_migrations WHERE to_version IS NOT NULL AND restored_version IS NULL`)).rows as { doc_id: string; from_version: number; to_version: number }[];
  for (const row of rows) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const executor = tx as unknown as DbExecutor;
        const result = await useCases(executor).restoreDecisionSections(row.doc_id, row.from_version, row.to_version);
        if (result === 'restored') await executor.execute(sql`UPDATE doc_decision_card_migrations SET restored_version = ${row.to_version + 1} WHERE doc_id = ${row.doc_id}::uuid`);
        return result;
      });
      if (outcome === 'restored') tally.restored++; else if (outcome === 'changed') tally.changed++; else tally.skipped++;
    } catch { tally.skipped++; }
  }
  return tally;
}

type Seals = Parameters<typeof sealResolverScope.run>[0];

/**
 * Runs the sweep at start and every 10 minutes. A test deployment (fixture token) runs it only when a test asks,
 * `POST /api/v1/test/doc-decision-cards` with the fixture bearer (optionally `{ docIds }`; `{ restore: true }` runs the
 * reversal; `{ fail }` injects a failure with that code), so no test's own doc text changes under it.
 */
export function registerDecisionCardMigration(app: FastifyInstance, { db, seals, fixtureToken }: { db: Database; seals: Seals; fixtureToken: string | null }) {
  const run = () => sealResolverScope.run(seals, () => sweepDecisionCards(db, app.log));
  if (fixtureToken !== null) {
    app.post<{ Body: { docIds?: string[]; restore?: boolean; fail?: string } | null }>('/api/v1/test/doc-decision-cards', {
      schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: {
        docIds: { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } },
        restore: { type: 'boolean' },
        fail: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
      } } },
    }, async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, fixtureToken)) return reply.code(401).send({ error: 'Unauthorized' });
      const { docIds: ids, restore, fail } = request.body ?? {};
      if (restore) return sealResolverScope.run(seals, () => restoreDecisionCards(db, ids));
      return ids ? sealResolverScope.run(seals, () => convertDecisionCardDocs(db, ids, app.log, fail)) : run();
    });
    return;
  }
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const tally = await run();
      if (tally.converted || tally.skipped) app.log.info({ decisionCards: tally }, 'Wiki decision cards migration pass');
    } catch (error) { app.log.error({ code: (error as { code?: unknown }).code ?? null }, 'Wiki decision cards migration pass failed'); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void sweep(); }, SWEEP_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  app.addHook('onReady', async () => { void sweep(); });
}
