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
 * tried again by a later sweep. Core decides what converts (`convertDecisionSections`); nothing else is rewritten.
 */

const PAGE = 200;
const SWEEP_MS = 600_000;

export interface DecisionCardSweep { converted: number; unchanged: number; skipped: number }

async function convertOne(db: Database, docId: string): Promise<DecisionCardConversion | 'skipped'> {
  try {
    return await db.transaction(async (tx) => {
      const executor = tx as unknown as DbExecutor;
      const uses = createDocUseCases({ run: (work) => withTaskUseErrors(() => work(docPorts(executor))) });
      const done = await executor.execute(sql`SELECT 1 FROM doc_decision_card_migrations WHERE doc_id = ${docId}::uuid`);
      if (done.rows.length) return { status: 'unchanged', converted: 0, kept: 0 } as DecisionCardConversion;
      const outcome = await uses.convertDecisionSections(docId);
      if (outcome.status === 'busy' || outcome.status === 'gone') return outcome;
      await executor.execute(sql`INSERT INTO doc_decision_card_migrations (doc_id, workspace_id, from_version, to_version, converted, kept)
        SELECT m.id, m.workspace_id, ${outcome.fromVersion!}, ${outcome.toVersion ?? null}, ${outcome.converted}, ${outcome.kept}
        FROM project_materials m WHERE m.id = ${docId}::uuid ON CONFLICT (doc_id) DO NOTHING`);
      return outcome;
    });
  } catch {
    // Locked here (WORKSPACE_LOCKED), or any other refusal: the doc stays unrecorded and a later pass tries again.
    return 'skipped';
  }
}

/** Converts the named docs only (the test route's way to stay inside its own docs). */
export async function convertDecisionCardDocs(db: Database, ids: readonly string[]): Promise<DecisionCardSweep> {
  const tally: DecisionCardSweep = { converted: 0, unchanged: 0, skipped: 0 };
  for (const id of ids) count(tally, await convertOne(db, id));
  return tally;
}

function count(tally: DecisionCardSweep, outcome: DecisionCardConversion | 'skipped') {
  if (outcome === 'skipped' || outcome.status === 'busy' || outcome.status === 'gone') tally.skipped++;
  else if (outcome.status === 'converted') tally.converted++;
  else tally.unchanged++;
}

/** One pass over every doc not converted yet, in id order. */
export async function sweepDecisionCards(db: Database): Promise<DecisionCardSweep> {
  const tally: DecisionCardSweep = { converted: 0, unchanged: 0, skipped: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = (await db.execute(sql`SELECT m.id FROM project_materials m WHERE m.kind = 'doc' AND m.id > ${after}::uuid
      AND NOT EXISTS (SELECT 1 FROM doc_decision_card_migrations x WHERE x.doc_id = m.id) ORDER BY m.id LIMIT ${PAGE}`)).rows as { id: string }[];
    for (const { id } of page) count(tally, await convertOne(db, id));
    if (page.length < PAGE) return tally;
    after = page[page.length - 1]!.id;
  }
}

type Seals = Parameters<typeof sealResolverScope.run>[0];

/**
 * Runs the sweep at start and every 10 minutes. A test deployment (fixture token) runs it only when a test asks,
 * `POST /api/v1/test/doc-decision-cards` with the fixture bearer (optionally `{ docIds }`), so no test's own doc text
 * changes under it.
 */
export function registerDecisionCardMigration(app: FastifyInstance, { db, seals, fixtureToken }: { db: Database; seals: Seals; fixtureToken: string | null }) {
  const run = () => sealResolverScope.run(seals, () => sweepDecisionCards(db));
  if (fixtureToken !== null) {
    app.post<{ Body: { docIds?: string[] } | null }>('/api/v1/test/doc-decision-cards', {
      schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { docIds: { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } } } } },
    }, async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, fixtureToken)) return reply.code(401).send({ error: 'Unauthorized' });
      const ids = request.body?.docIds;
      return ids ? sealResolverScope.run(seals, () => convertDecisionCardDocs(db, ids)) : run();
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
