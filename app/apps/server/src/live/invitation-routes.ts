import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { LIVE_INVITATIONS_PATH, liveInvitePath, liveInvitationReplyPath,
  type InviteLiveSessionCommand, type ReplyLiveInvitationCommand } from '@flux/contracts';
import { InvalidInputError, liveInvitationUseCases, type Database, type LiveInvitationCursor } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { liveInvitationStore } from './invitations.js';

interface Options { db: Database; sessions: SessionResolver; cursorSecret: string }
const id = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
function cursor(value: string | undefined, userId: string, key: Buffer): LiveInvitationCursor | null {
  if (value === undefined) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidInputError('Invalid live invitation cursor');
  try {
    const encoded = Buffer.from(value, 'base64url');
    if (encoded.length < 29) throw new Error('cursor length');
    const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(encoded.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]);
    const decoded: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('cursor shape');
    return decoded as LiveInvitationCursor;
  } catch { throw new InvalidInputError('Invalid live invitation cursor'); }
}
function encodeCursor(value: LiveInvitationCursor, userId: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(userId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export async function liveInvitationRoutes(app: FastifyInstance, { db, sessions, cursorSecret }: Options) {
  useDomainErrors(app);
  const invitation = liveInvitationUseCases(liveInvitationStore(db));
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(cursorSecret),
    Buffer.from('flux-live-invitation-cursor-v1'), Buffer.from('recipient-page'), 32));
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) =>
    (await sessions.requirePrincipal(request)).principal;

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(LIVE_INVITATIONS_PATH, {
    schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { cursor: { type: 'string', maxLength: 512 }, limit: { type: 'string', pattern: '^[1-9][0-9]?$|^100$' } } } },
  }, async (request) => {
    const actor = await principal(request);
    const page = await invitation.listPending(actor, cursor(request.query.cursor, actor.id, key),
      request.query.limit === undefined ? 50 : Number(request.query.limit));
    return { items: page.items, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor, actor.id, key) : null };
  });

  app.post<{ Params: { sessionId: string }; Body: InviteLiveSessionCommand }>(liveInvitePath(':sessionId'), {
    schema: { params: { type: 'object', required: ['sessionId'], properties: { sessionId: id } },
      body: { type: 'object', required: ['recipientId'], additionalProperties: false,
        properties: { recipientId: { type: 'string', minLength: 1, maxLength: 255 } } } },
  }, async (request, reply) => reply.code(201).send(await invitation.invite(
    await principal(request), request.params.sessionId, request.body.recipientId)));

  app.post<{ Params: { invitationId: string }; Body: ReplyLiveInvitationCommand }>(liveInvitationReplyPath(':invitationId'), {
    schema: { params: { type: 'object', required: ['invitationId'], properties: { invitationId: id } },
      body: { type: 'object', required: ['choice'], additionalProperties: false,
        properties: { choice: { type: 'string', enum: ['later', 'text'] } } } },
  }, async (request) => invitation.reply(await principal(request), request.params.invitationId, request.body.choice));
}
