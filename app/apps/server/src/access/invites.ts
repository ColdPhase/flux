import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INVITE_ACCEPT_PATH, INVITE_EXPIRY_DAYS, INVITE_PREVIEW_PATH, WORKSPACES_PATH, type CreateInviteCommand, type InviteTokenCommand } from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { accessPorts, agentAccessRequestRows, type Database } from '@flux/db';
import { acceptInvite, createInvite, createNotification, listInvites, NotFoundError, previewInvite, revokeInvite, withLink,
  type CreatedInvite, type InviteJoined, type InviteSigner } from '@flux/core';
import { notificationUnitOfWork, pgBossQueue } from '../push/adapters.js';
import { joinRateLimiter, type JoinRateLimiter } from '../live/rate-limit.js';
import { requires } from '../http/commands.js';
import type { AccessContext } from './context.js';

/** Per API process, like the live join limit (a guard, not a global count): F-035 rate limits. */
export interface InviteLimiters { preview: JoinRateLimiter; accept: JoinRateLimiter; create: JoinRateLimiter }

export function inviteLimiters(): InviteLimiters {
  const make = (limit: number, what: string) => joinRateLimiter({ limit, windowMs: 60_000, maxUsers: 10_000,
    message: `Too many invite ${what} in a short time; try again shortly`, code: 'INVITE_RATE_LIMITED' });
  return { preview: make(30, 'checks'), accept: make(10, 'attempts'), create: make(30, 'links') };
}

const tokenBody = { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 128 } } } as const;

/**
 * Invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035). Create, list and revoke need an
 * owner or admin. Preview needs no session; accept needs one and is idempotent by itself (no Idempotency-Key row,
 * which would only store the token's answer). The token never reaches a stored answer, an event or a log.
 */
export function inviteRoutes(app: FastifyInstance, { db, principal, command, sessions, workspaceScope, inviteVerifiedEmail }: AccessContext,
  signer: InviteSigner, limits: InviteLimiters, boss: Pick<PgBoss, 'send'>) {
  // #763 FT-3: the person who made the link hears that it was used, in the same transaction as the join.
  const onJoined: InviteJoined = async (tx, joined) => {
    const names = await agentAccessRequestRows(tx as Database).names([joined.userId]);
    const who = names.get(joined.userId) ?? 'Someone';
    const projectName = joined.projectId ? (await accessPorts.invites(tx as Database).projectName(joined.workspaceId, joined.projectId)) : null;
    try {
      const notification = await createNotification(notificationUnitOfWork(tx as Database, pgBossQueue(boss)), {
        userId: joined.inviterId, source: joined.projectId ? { type: 'project', id: joined.projectId } : { type: 'workspace', id: joined.workspaceId },
        title: (projectName ? `${who} joined ${projectName}` : `${who} joined your space`).slice(0, 200),
        body: projectName ? 'They can open the project now.' : 'Give them access to a project in People.',
        url: joined.projectId ? `/projects/${joined.projectId}?open=people` : '/', aiOrigin: false,
      });
      // Without a project, giving access is the one thing left to do: it waits in Needs you.
      if (!joined.projectId) await agentAccessRequestRows(tx as Database).markQuestion(notification.id);
    } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
  };
  const who = async (request: FastifyRequest) => {
    const session = await sessions.resolveSession(request.headers);
    return { session, key: session ? `user:${session.principal.id}` : `ip:${request.ip}` };
  };

  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/invites`, async (request) =>
    listInvites(await principal(request), request.params.workspaceId, db, accessPorts, signer));

  app.post<{ Params: { workspaceId: string }; Body: CreateInviteCommand }>(`${WORKSPACES_PATH}/:workspaceId/invites`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: {
      role: { type: 'string', enum: ['admin', 'member', 'guest'] }, email: { type: ['string', 'null'], maxLength: 320 },
      expiresInDays: { type: 'integer', enum: [...INVITE_EXPIRY_DAYS] }, projectId: { type: ['string', 'null'], maxLength: 64 } } } },
    // The stored idempotent answer has no link; it is derived again on every answer, replays included.
    preSerialization: async (_request: FastifyRequest, _reply: unknown, payload: unknown) =>
      payload && typeof payload === 'object' && 'expiresAt' in payload && !('link' in payload) ? withLink(signer, payload as CreatedInvite) : payload,
  }, async (request, reply) => {
    limits.create.take(`user:${(await principal(request)).id}`);
    return command(request, reply, {
      operation: `POST ${WORKSPACES_PATH}/:workspaceId/invites`, scope: workspaceScope(request.params.workspaceId), status: 201,
      run: (actor, conn) => createInvite(actor, request.params.workspaceId, request.body, conn, accessPorts, signer),
      replay: requires('workspace', 'workspace.manage_members', () => request.params.workspaceId),
    });
  });

  app.delete<{ Params: { workspaceId: string; inviteId: string } }>(`${WORKSPACES_PATH}/:workspaceId/invites/:inviteId`, async (request, reply) => {
    await revokeInvite(await principal(request), request.params.workspaceId, request.params.inviteId, db, accessPorts);
    return reply.code(204).send();
  });

  app.post<{ Body: InviteTokenCommand }>(INVITE_PREVIEW_PATH, { schema: { body: tokenBody } }, async (request) => {
    const { session, key } = await who(request);
    limits.preview.take(key);
    return previewInvite(session?.principal ?? null, request.body.token, db, accessPorts, signer);
  });

  app.post<{ Body: InviteTokenCommand }>(INVITE_ACCEPT_PATH, { schema: { body: tokenBody } }, async (request) => {
    const actor = await principal(request);
    limits.accept.take(`user:${actor.id}`);
    return acceptInvite(actor, request.body.token, db, accessPorts, signer, { verifiedEmailOnly: inviteVerifiedEmail, onJoined });
  });
}
