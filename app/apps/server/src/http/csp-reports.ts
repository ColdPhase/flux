import type { FastifyInstance } from 'fastify';
import { bearerMatches } from '../fixture/index.js';

/** Where a test deployment's pages send what the Content-Security-Policy refused (`report-uri`, #979). */
export const CSP_REPORT_PATH = '/api/v1/test/csp-reports';
const KEPT = 500;

export interface CspReport { at: string; document: string; directive: string; blocked: string; source: string; line: number | null; sample: string }

const text = (value: unknown, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : '');

/**
 * TEST DEPLOYMENTS ONLY (`FLUX_FIXTURE_TOKEN` with `FLUX_TEST_FAILURE_INJECTION=true`; a production install has no such route and its
 * policy has no `report-uri`). Every browser that opens a page of the test stack reports a refused script, style, connection, image or
 * frame here, so a whole UI run in Chromium and WebKit is judged for violations without each test looking at its console:
 * scripts/check_ui.sh reads the list at the end and fails when it is not empty. The list is bounded and kept in memory.
 *
 *   POST   the browser's report (`application/csp-report`; no credentials needed, a report cannot do more than add a line)
 *   GET    the reports, with the fixture bearer
 *   DELETE clears them, with the fixture bearer
 */
export async function cspReportRoutes(app: FastifyInstance, { token }: { token: string }) {
  const reports: CspReport[] = [];
  for (const type of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
      try { done(null, JSON.parse(String(body))); } catch { done(null, {}); }
    });
  }
  app.post(CSP_REPORT_PATH, async (request, reply) => {
    const body = request.body as { 'csp-report'?: Record<string, unknown> } | undefined;
    const report = body?.['csp-report'];
    if (!report || typeof report !== 'object') return reply.code(204).send();
    reports.push({
      at: new Date().toISOString(),
      document: text(report['document-uri']),
      directive: text(report['effective-directive'] ?? report['violated-directive'], 80),
      blocked: text(report['blocked-uri']),
      source: text(report['source-file']),
      line: typeof report['line-number'] === 'number' ? report['line-number'] : null,
      sample: text(report['script-sample'], 120),
    });
    if (reports.length > KEPT) reports.shift();
    return reply.code(204).send();
  });
  const guarded = { onRequest: async (request: { headers: { authorization?: string } }, reply: { code(status: number): { send(body: unknown): unknown } }) => {
    if (!bearerMatches(request.headers.authorization, token)) return reply.code(401).send({ error: 'Unauthorized' });
  } };
  app.get(CSP_REPORT_PATH, guarded, async () => ({ reports }));
  app.delete(CSP_REPORT_PATH, guarded, async (_request, reply) => {
    reports.length = 0;
    return reply.code(204).send();
  });
}
