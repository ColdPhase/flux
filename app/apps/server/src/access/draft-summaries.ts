import type { FastifyInstance } from 'fastify';
import { DRAFTS_PATH } from '@flux/contracts';
import { getDraftSummary, listDraftSummaries, requestDraftSummary } from '@flux/core';
import type { PgBoss } from 'pg-boss';
import { draftResultRepository } from '@flux/db';
import { requires } from '../http/commands.js';
import { pgBossQueue } from '../push/adapters.js';
import type { AccessContext } from './context.js';

/** Draft summaries (#85, #87): request one (the job commits with its result row) and read them. */
export function draftSummaryRoutes(app: FastifyInstance, { db, principal, command, draftScope }: AccessContext, boss: Pick<PgBoss, 'send'>) {
  // The job commits with its result row.
  const summaries = { results: draftResultRepository, queue: pgBossQueue(boss) };
  app.post<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId/summaries`, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/summaries`, scope: draftScope(request.params.draftId), status: 202,
    run: (actor, conn) => requestDraftSummary(actor, request.params.draftId, conn, summaries),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.get<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId/summaries`, async (request) =>
    listDraftSummaries(await principal(request), request.params.draftId, db, draftResultRepository));
  app.get<{ Params: { draftId: string; resultId: string } }>(`${DRAFTS_PATH}/:draftId/summaries/:resultId`, async (request) =>
    getDraftSummary(await principal(request), request.params.draftId, request.params.resultId, db, draftResultRepository));
}
