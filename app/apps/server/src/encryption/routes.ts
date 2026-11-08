import type { FastifyInstance, FastifyReply } from 'fastify';
import { ENCRYPTED_SPACES_AVAILABILITY_PATH, ENCRYPTED_WORKSPACES_PATH, WORKSPACES_PATH, companyEncryptedSpacesPath, encryptedSpacePath,
  type CreateEncryptedWorkspaceCommand, type EncryptedSpacesAvailability, type GrantUnlockPasswordCommand, type NewRecoveryCodeCommand, type Project,
  type SetUnlockPasswordCommand, type UnlockWorkspaceCommand } from '@flux/contracts';
import { InvalidInputError, RateLimitedError, type Principal } from '@flux/core';
import { afterDeadlock } from '@flux/db';
import { bearerMatches } from '../fixture/index.js';
import type { SessionResolver } from '../identity/index.js';
import type { EncryptionComposition } from './adapters.js';
import { audited } from '../security-log.js';

/**
 * The encrypted-workspace routes (F-030, #655; docs/product/encrypted-workspaces.md#api). Every one needs a live session
 * and the origin check (the API's state-changing request guard), answers `Cache-Control: no-store`, and never uses
 * the Idempotency-Key store. The secrets in their bodies are never logged: Fastify logs no request body, and the
 * request serializer drops query strings.
 */
const secret = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const body = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as const;

export function encryptionRoutes(app: FastifyInstance, { sessions, encryption, fixtureCreation, productionCreation = false, firstSpace }: {
  sessions: SessionResolver;
  encryption: EncryptionComposition;
  /**
   * S1 and S2: the fixture token when this is a test deployment (`FLUX_FIXTURE_TOKEN` and `FLUX_TEST_FAILURE_INJECTION=true`),
   * else null. Creation exists only then, and only with that bearer as well as a session: a `./flux up` install, which
   * always has a fixture token, never gets it. S3 makes it the production route.
   */
  fixtureCreation: string | null;
  /** Creation is a production route, no fixture bearer. Off until the switch in `app.ts` is flipped. */
  productionCreation?: boolean;
  /**
   * F-037, C-24: the one space an encrypted space of a company holds, made for the creator right after the workspace (its name is the
   * space's). Idempotent: a workspace that already holds its space returns it, so a retried creation ends with one.
   */
  firstSpace: (principal: Principal, workspaceId: string, name: string) => Promise<Project>;
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

  if (productionCreation || fixtureCreation !== null) {
    const token = productionCreation ? null : fixtureCreation;
    app.post<{ Body: CreateEncryptedWorkspaceCommand }>(ENCRYPTED_WORKSPACES_PATH, {
      onRequest: async (request, reply) => {
        if (token !== null && !bearerMatches(request.headers.authorization, token)) return reply.code(401).send({ error: 'Unauthorized' });
      },
      schema: { body: body({ name: { type: 'string', minLength: 1, maxLength: 400 }, creationId: { type: 'string', maxLength: 64 }, password: secret,
        companyId: { type: 'string', maxLength: 64 }, people: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } },
        recoveryCode: { type: 'string', minLength: 1, maxLength: 200 } }, ['name', 'creationId', 'password']) },
    }, async (request, reply) => {
      const creator = await principal(request);
      const fixture = fixtureCreation !== null && bearerMatches(request.headers.authorization, fixtureCreation);
      // Everyone but the test deployment's fixture makes an encrypted space of their company (any member who is not a guest, C-24).
      if (!fixture && !request.body.companyId) throw new InvalidInputError('An encrypted space belongs to a company: say which', 'ENCRYPTED_SPACE_COMPANY_ONLY');
      const { status, body: result } = await useCases.create(creator, request.body);
      const project = request.body.companyId ? await firstSpace(creator, result.workspace.id, request.body.name.trim()) : null;
      return reply.code(status).send({ ...result, project });
    });
  }
  app.get<{ Reply: EncryptedSpacesAvailability }>(ENCRYPTED_SPACES_AVAILABILITY_PATH, async (request) => {
    await principal(request);
    return { available: encryption.keys.availability === 'ok' };
  });
  app.get<{ Params: { companyId: string } }>(companyEncryptedSpacesPath(':companyId'), async (request) =>
    useCases.companySpaces(await principal(request), request.params.companyId));
  app.delete<{ Params: { workspaceId: string } }>(encryptedSpacePath(':workspaceId'), async (request, reply) => {
    const who = await principal(request);
    // The cascade locks the space's messages in the database's own order, as for a plain space's delete: run it once more if PostgreSQL
    // cancels it to break a deadlock with a notice batch (#1052). The cancelled attempt kept nothing, and the keys are forgotten only after a commit.
    await afterDeadlock(() => useCases.deleteSpace(who, request.params.workspaceId));
    return reply.code(204).send();
  });
  app.post<{ Params: { workspaceId: string }; Body: UnlockWorkspaceCommand }>(`${WORKSPACES_PATH}/:workspaceId/unlock`, {
    schema: { body: body({ password: secret, recoveryCode: { type: 'string', minLength: 1, maxLength: 200 } }) },
  }, async (request) => {
    // Who tried to unlock which space, and whether it worked (a wrong secret, a rate limit): a security event, never the secret (#997).
    const who = await principal(request);
    return audited(request.log, { event: 'space_unlock', userId: who.id, workspaceId: request.params.workspaceId, ip: request.ip },
      () => useCases.unlock(who, request.params.workspaceId, request.body ?? {}));
  });
  app.post<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/lock`, async (request) => {
    const who = await principal(request);
    return audited(request.log, { event: 'space_lock', userId: who.id, workspaceId: request.params.workspaceId, ip: request.ip }, () => useCases.lock(who, request.params.workspaceId));
  });
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
