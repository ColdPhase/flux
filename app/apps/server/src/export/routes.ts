import type { FastifyInstance } from 'fastify';
import { projectExportPath } from '@flux/contracts';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, useDomainErrors } from '../http/commands.js';
import { exportUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver; publicOrigin: string }

const query = { type: 'object', additionalProperties: false, properties: { format: { type: 'string', enum: ['json', 'bundle'] } } } as const;

/**
 * `GET /api/v1/projects/:projectId/export` (#123). Needs `project.manage`: an invisible project is
 * `404`, a visible one the caller may not manage is `403`. `?format=bundle` answers the `.tar.gz`
 * bundle (docs/operations/export.md); the default is the `project.json` document.
 */
export async function exportRoutes(app: FastifyInstance, { db, sessions, publicOrigin }: Options) {
  useDomainErrors(app);
  const { principal } = commandRunner(db, sessions);
  const exports = exportUseCases(db, publicOrigin);

  app.get<{ Params: { projectId: string }; Querystring: { format?: 'json' | 'bundle' } }>(projectExportPath(':projectId'), { schema: { querystring: query } },
    async (request, reply) => {
      const actor = await principal(request);
      reply.header('cache-control', 'no-store');
      if (request.query.format === 'bundle') {
        const bundle = await exports.exportBundle(actor, request.params.projectId);
        return reply.header('content-type', 'application/gzip')
          .header('content-disposition', `attachment; filename="${bundle.fileName}"`).send(bundle.content);
      }
      return reply.send(await exports.exportProject(actor, request.params.projectId));
    });
}
