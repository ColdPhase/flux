import type { PgBoss } from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { assistantOperatorRequestPath } from '@flux/contracts';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { registerAssistantChangeRoutes } from './changes.js';
import { assistantOperatorUseCases } from './operator.js';
import type { Provider as GithubProvider } from '../github/adapters.js';

/** `github`: the read-only App provider, for an approved pull-request link of a local client (#1419). */
interface Options { db: Database; sessions: SessionResolver; boss: Pick<PgBoss, 'send'>; github?: GithubProvider | null }

/** The operator request and the change log of agents (F-036 AG-3). An agent's own page is `/api/v1/my-agents`. */
export async function assistantRoutes(app: FastifyInstance, { db, sessions, boss, github = null }: Options) {
  useDomainErrors(app);
  const operator = assistantOperatorUseCases(db, boss);
  app.post<{ Params: { workspaceId: string }; Body: { client?: 'claude_code' | 'codex' } | undefined }>(assistantOperatorRequestPath(':workspaceId'),
    { schema: { body: { type: 'object', additionalProperties: false, properties: { client: { type: 'string', enum: ['claude_code', 'codex'] } } } } }, async (request, reply) =>
      reply.code(201).send(await operator.request((await sessions.requirePrincipal(request)).principal, request.params.workspaceId, request.body?.client === 'codex' ? 'ChatGPT' : 'Claude')));
  // The change line, Undo and waiting changes (F-036 AG-3).
  registerAssistantChangeRoutes(app, db, sessions, github);

}
