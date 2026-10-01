import type { LiveContextRef } from '@flux/contracts';
import { ConflictError, DomainError, InvalidInputError, NotFoundError, RuleViolationError, ServiceUnavailableError } from '../access/errors.js';
import type { Principal } from '../principal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LiveInvitationTarget {
  id: string;
  projectId: string;
  context: LiveContextRef;
  state: 'available' | 'rotating' | 'ending' | 'ended';
}

/** IDs and choice only. No room ID, media token, private title or message body. */
export interface LiveInvitation {
  id: string;
  sessionId: string;
  projectId: string;
  inviterId: string;
  recipientId: string;
  response: 'pending' | 'later' | 'text';
  createdAt: string;
  respondedAt: string | null;
}

/** Keep the database timestamp's full precision for stable keyset pagination. */
export interface LiveInvitationCursor { createdAt: string; id: string }
export interface LiveInvitationPage { items: LiveInvitation[]; nextCursor: LiveInvitationCursor | null }
export interface LiveInvitationPageRow { invitation: LiveInvitation; cursor: LiveInvitationCursor }

export interface LiveInvitationAccess {
  loadSession(sessionId: string): Promise<LiveInvitationTarget | null>;
  /** Must lock current project policy and the current anchor's audience through commit. */
  requireProjectAndAnchor(principal: Principal, target: LiveInvitationTarget): Promise<void>;
}

export interface LiveInvitationRepository {
  /**
   * Atomically unique on (sessionId, recipientId); return the existing row on retry/race.
   * Only when it inserts a new row, the adapter records `project.live_invited.v1` (project
   * object; `{ sessionId, invitationId, recipientId }`, as the inviter) in the same
   * transaction as its last write, so the recipient gets one inbox signal per invitation.
   */
  insertOrGet(sessionId: string, projectId: string, inviterId: string, recipientId: string): Promise<LiveInvitation>;
  find(invitationId: string): Promise<LiveInvitation | null>;
  /** Compare-and-set pending to choice; return the final row after a concurrent retry. */
  respondIfPending(invitationId: string, recipientId: string, choice: 'later' | 'text'): Promise<LiveInvitation>;
  /** Newest first, pending only, for exactly this recipient; keyset cursor keeps database precision. */
  pendingForRecipient(recipientId: string, cursor: LiveInvitationCursor | null, limit: number): Promise<LiveInvitationPageRow[]>;
}

export interface LiveInvitationPorts {
  /** Supplies one transaction-bound access and repository pair for a whole command. */
  withTransaction<T>(work: (access: LiveInvitationAccess, invitations: LiveInvitationRepository) => Promise<T>): Promise<T>;
}

export type LiveInvitationReply =
  | { invitation: LiveInvitation; next: { kind: 'stay' } }
  | { invitation: LiveInvitation; next: { kind: 'open_project_conversation'; projectId: string; context: LiveContextRef } };

function uuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new InvalidInputError(`${name} must be a UUID`);
  return value;
}

function userId(value: string): string {
  // Auth provider IDs are opaque text, not necessarily UUIDs.
  if (typeof value !== 'string' || value.length === 0 || value.length > 255)
    throw new InvalidInputError('recipientId must be a nonempty user ID');
  return value;
}

function validCursor(cursor: LiveInvitationCursor | null): void {
  if (!cursor) return;
  if (typeof cursor.createdAt !== 'string' || cursor.createdAt.length > 80 ||
      !Number.isFinite(Date.parse(cursor.createdAt)))
    throw new InvalidInputError('cursor.createdAt must be a timestamp');
  uuid(cursor.id, 'cursor.id');
}

function person(principal: Principal): void {
  if (principal.kind !== 'human') throw new RuleViolationError('Only people use live invitations', 'HUMAN_INVITATION_REQUIRED');
}

async function readable(access: LiveInvitationAccess, principal: Principal, target: LiveInvitationTarget,
  kind: 'session' | 'recipient' | 'invitation'): Promise<void> {
  try { await access.requireProjectAndAnchor(principal, target); }
  catch (error) {
    if (!(error instanceof DomainError) || (error.status !== 403 && error.status !== 404)) throw error;
    if (kind === 'recipient') throw new NotFoundError('Recipient', 'LIVE_RECIPIENT_NOT_FOUND');
    if (kind === 'invitation') throw new NotFoundError('Live invitation', 'LIVE_INVITATION_NOT_FOUND');
    throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
  }
}

function available(target: LiveInvitationTarget): void {
  if (target.state !== 'available')
    throw new RuleViolationError('This live session is not available for invitations', 'LIVE_SESSION_UNAVAILABLE');
}

function invitationView(row: LiveInvitation): LiveInvitation {
  return {
    id: row.id, sessionId: row.sessionId, projectId: row.projectId,
    inviterId: row.inviterId, recipientId: row.recipientId,
    response: row.response, createdAt: row.createdAt, respondedAt: row.respondedAt,
  };
}

/**
 * Domain-only invitation flow. The adapter must serialize access changes with
 * invitation writes and keep a database unique key on (session, recipient). Text
 * hands the user to the ordinary project conversation path; this use case never
 * writes a message or asks the SFU for a token.
 */
export function liveInvitationUseCases(ports: LiveInvitationPorts) {
  return {
    async listPending(recipient: Principal, cursor: LiveInvitationCursor | null = null,
      limit = 50): Promise<LiveInvitationPage> {
      person(recipient);
      validCursor(cursor);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new InvalidInputError('limit must be between 1 and 100');
      return ports.withTransaction(async (access, invitations) => {
        const items: LiveInvitation[] = [];
        let scanned = 0;
        let after = cursor;
        // A hidden row must not consume a visible slot. Keep scanning in bounded
        // batches; the transport seals the internal cursor before returning it.
        while (scanned < 500) {
          const take = Math.min(100, 500 - scanned);
          const batch = await invitations.pendingForRecipient(recipient.id, after, take);
          if (batch.length === 0) return { items, nextCursor: null };
          for (const { invitation, cursor: rowCursor } of batch) {
            const before = after;
            after = rowCursor;
            scanned++;
            if (invitation.recipientId !== recipient.id || invitation.response !== 'pending' ||
                rowCursor.id !== invitation.id) continue;
            const target = await access.loadSession(invitation.sessionId);
            if (!target || target.projectId !== invitation.projectId) continue;
            try { await access.requireProjectAndAnchor(recipient, target); }
            catch (error) {
              if (error instanceof DomainError &&
                  (error.status === 403 || error.status === 404 || error.code === 'LIVE_SESSION_UNAVAILABLE')) continue;
              throw error;
            }
            if (target.state !== 'available') continue;
            if (items.length === limit) return { items, nextCursor: before };
            items.push(invitationView(invitation));
          }
          if (batch.length < take) return { items, nextCursor: null };
        }
        if (items.length === 0)
          throw new ServiceUnavailableError('Invitation inbox is temporarily unavailable', 'LIVE_INVITATION_INBOX_UNAVAILABLE');
        return { items, nextCursor: after };
      });
    },

    async invite(inviter: Principal, sessionId: string, recipientId: string): Promise<LiveInvitation> {
      person(inviter);
      uuid(sessionId, 'sessionId');
      userId(recipientId);
      if (recipientId === inviter.id)
        throw new RuleViolationError('Invite another person', 'LIVE_SELF_INVITATION');
      return ports.withTransaction(async (access, invitations) => {
        const target = await access.loadSession(sessionId);
        if (!target || target.id !== sessionId) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        await readable(access, inviter, target, 'session');
        available(target);
        await readable(access, { kind: 'human', id: recipientId }, target, 'recipient');
        const invitation = await invitations.insertOrGet(sessionId, target.projectId, inviter.id, recipientId);
        // Storage owns the unique key; a broken adapter must never return a row
        // from another session, project or recipient to this caller.
        if (invitation.sessionId !== sessionId || invitation.projectId !== target.projectId || invitation.recipientId !== recipientId)
          throw new Error('Live invitation repository returned a row outside the requested audience');
        return invitationView(invitation);
      });
    },

    async reply(recipient: Principal, invitationId: string, choice: 'later' | 'text'): Promise<LiveInvitationReply> {
      person(recipient);
      uuid(invitationId, 'invitationId');
      if (choice !== 'later' && choice !== 'text') throw new InvalidInputError('choice must be later or text');
      return ports.withTransaction(async (access, invitations) => {
        const invitation = await invitations.find(invitationId);
        if (!invitation || invitation.recipientId !== recipient.id)
          throw new NotFoundError('Live invitation', 'LIVE_INVITATION_NOT_FOUND');
        const target = await access.loadSession(invitation.sessionId);
        if (!target || target.projectId !== invitation.projectId)
          throw new NotFoundError('Live invitation', 'LIVE_INVITATION_NOT_FOUND');
        await readable(access, recipient, target, 'invitation');
        available(target);
        const current = invitation.response === 'pending'
          ? await invitations.respondIfPending(invitationId, recipient.id, choice)
          : invitation;
        if (current.id !== invitation.id || current.sessionId !== target.id ||
            current.recipientId !== recipient.id || current.projectId !== target.projectId)
          throw new Error('Live invitation repository returned a row outside the requested audience');
        if (current.response !== choice)
          throw new ConflictError('This invitation already has another response', 'LIVE_INVITATION_RESPONSE_CONFLICT');
        if (choice === 'text') return { invitation: invitationView(current),
          next: { kind: 'open_project_conversation', projectId: target.projectId, context: target.context } };
        return { invitation: invitationView(current), next: { kind: 'stay' } };
      });
    },
  };
}
