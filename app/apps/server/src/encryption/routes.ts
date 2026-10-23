import type { FastifyInstance, FastifyReply } from 'fastify';
import { ENCRYPTED_WORKSPACES_PATH, WORKSPACES_PATH, type CreateEncryptedWorkspaceCommand, type GrantUnlockPasswordCommand,
  type NewRecoveryCodeCommand, type SetUnlockPasswordCommand, type UnlockWorkspaceCommand } from '@flux/contracts';
import { RateLimitedError } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import type { EncryptionComposition } from './adapters.js';

/**
 * The encrypted-workspace routes (F-030, #655; docs/product/encrypted-workspaces.md#api). Every one needs a live session
 * and the origin check (the API's state-changing request guard), answers `Cache-Control: no-store`, and never uses
 * the Idempotency-Key store. The secrets in their bodies are never logged: Fastify logs no request body, and the
 * request serializer drops query strings.
 */
const secret = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const body = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as const;

export function encryptionRoutes(app: FastifyInstance, { sessions, encryption, fixtureCreation }: {
  sessions: SessionResolver;
  encryption: EncryptionComposition;
  /** S1 and S2: creation exists only in a test deployment (`FLUX_FIXTURE_TOKEN` set). S3 makes it the production route. */
  fixtureCreation: boolean;
}) {
  const { useCases } = encryption;
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');
  app.addHook('onSend', async (_request, reply) => { noStore(reply); });
  app.setErrorHandler((error, _request, reply) => {
    noStore(reply);
    if (error instanceof RateLimitedError) reply.header('retry-after', String(error.retryAfterSeconds));
    throw error;
  });

  if (fixtureCreation) {
    app.post<{ Body: CreateEncryptedWorkspaceCommand }>(ENCRYPTED_WORKSPACES_PATH, {
      schema: { body: body({ name: { type: 'string', minLength: 1, maxLength: 400 }, creationId: { type: 'string', maxLength: 64 }, password: secret },
        ['name', 'creationId', 'password']) },
    }, async (request, reply) => {
      const { status, body: result } = await useCases.create(await principal(request), request.body);
      return reply.code(status).send(result);
    });
  }
  app.post<{ Params: { workspaceId: string }; Body: UnlockWorkspaceCommand }>(`${WORKSPACES_PATH}/:workspaceId/unlock`, {
    schema: { body: body({ password: secret, recoveryCode: { type: 'string', minLength: 1, maxLength: 200 } }) },
  }, async (request) => useCases.unlock(await principal(request), request.params.workspaceId, request.body ?? {}));
  app.post<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/lock`,
    async (request) => useCases.lock(await principal(request), request.params.workspaceId));
  app.post<{ Params: { workspaceId: string }; Body: GrantUnlockPasswordCommand }>(`${WORKSPACES_PATH}/:workspaceId/unlock-password-grants`, {
    schema: { body: body({ userId: { type: 'string', minLength: 1, maxLength: 200 }, password: secret }, ['userId', 'password']) },
  }, async (request, reply) => reply.code(201).send(await useCases.grant(await principal(request), request.params.workspaceId, request.body)));
  app.put<{ Params: { workspaceId: string }; Body: SetUnlockPasswordCommand }>(`${WORKSPACES_PATH}/:workspaceId/unlock-password`, {
    schema: { body: body({ currentPassword: secret, recoveryCode: { type: 'string', minLength: 1, maxLength: 200 }, newPassword: secret }, ['newPassword']) },
  }, async (request) => useCases.setPassword(await principal(request), request.params.workspaceId, request.body));
  app.post<{ Params: { workspaceId: string }; Body: NewRecoveryCodeCommand }>(`${WORKSPACES_PATH}/:workspaceId/recovery-code`, {
    schema: { body: body({ password: secret }, ['password']) },
  }, async (request) => useCases.newRecoveryCode(await principal(request), request.params.workspaceId, request.body));
}
