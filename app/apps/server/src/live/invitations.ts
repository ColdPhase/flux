import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import {
  enforce, evaluateProject, NotFoundError, recordEvent, RuleViolationError,
  type Database, type Principal, type LiveInvitation, type LiveInvitationPorts, type LiveInvitationTarget,
  type LiveInvitationCursor, type LiveInvitationPageRow,
} from '@flux/core';
import type { LiveContextRef } from '@flux/contracts';
import { requireLiveContext } from './access.js';
import { eventPorts } from '../events.js';

interface InvitationRow {
  id: string;
  session_id: string;
  project_id: string;
  inviter_id: string;
  recipient_id: string;
  response: 'pending' | 'later' | 'text';
  created_at: Date | string;
  responded_at: Date | string | null;
}

function record(row: InvitationRow): LiveInvitation {
  return {
    id: row.id, sessionId: row.session_id, projectId: row.project_id,
    inviterId: row.inviter_id, recipientId: row.recipient_id,
    response: row.response, createdAt: new Date(row.created_at).toISOString(),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
  };
}

function context(row: typeof schema.liveSessions.$inferSelect): LiveContextRef {
  if (row.conversationId) return { type: 'conversation', id: row.conversationId };
  if (row.workId) return { type: 'work', id: row.workId };
  if (row.sketchId) return { type: 'sketch', id: row.sketchId };
  if (row.docId) return { type: 'doc', id: row.docId };
  throw new Error('Live session has no context');
}

function sameContext(left: LiveContextRef, right: LiveContextRef): boolean {
  return left.type === right.type && left.id === right.id;
}

const columns = sql`id, session_id, project_id, inviter_id, recipient_id, response, created_at, responded_at`;

/** Committed with a new invitation; the worker turns it into the recipient's one inbox signal. */
export const LIVE_INVITED_EVENT = 'project.live_invited.v1';

/** Transaction-bound invitation persistence and current access checks. */
export function liveInvitationStore(db: Database): LiveInvitationPorts {
  return {
    withTransaction(work) {
      return db.transaction(async (tx) => {
        const access = {
          async loadSession(sessionId: string): Promise<LiveInvitationTarget | null> {
            // Locate without taking the session lock first. Policy's project lock
            // must precede the session lock to match revocation's lock order.
            const [row] = await tx.select().from(schema.liveSessions)
              .where(eq(schema.liveSessions.id, sessionId));
            return row ? { id: row.id, projectId: row.projectId,
              context: context(row), state: row.state } : null;
          },
          async requireProjectAndAnchor(principal: Principal, target: LiveInvitationTarget): Promise<void> {
            enforce(await evaluateProject(principal, 'project.read', target.projectId, tx, { lock: true }), 'project');
            await requireLiveContext(principal, target.context, target.projectId, tx, true);
            const [locked] = await tx.select().from(schema.liveSessions)
              .where(eq(schema.liveSessions.id, target.id)).for('share');
            if (!locked || locked.projectId !== target.projectId || !sameContext(context(locked), target.context))
              throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
            if (locked.state !== 'available')
              throw new RuleViolationError('This live session is not available for invitations', 'LIVE_SESSION_UNAVAILABLE');
          },
        };
        const invitations = {
          async pendingForRecipient(recipientId: string, cursor: LiveInvitationCursor | null,
            limit: number): Promise<LiveInvitationPageRow[]> {
            const result = await tx.execute(sql`
              SELECT ${columns}, created_at::text AS cursor_created_at FROM live_invitations
              WHERE recipient_id = ${recipientId} AND response = 'pending'
                AND (${cursor === null} OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
              ORDER BY created_at DESC, id DESC
              LIMIT ${limit}
            `);
            return result.rows.map((value) => {
              const row = value as unknown as InvitationRow & { cursor_created_at: string };
              return { invitation: record(row), cursor: { createdAt: row.cursor_created_at, id: row.id } };
            });
          },
          async insertOrGet(sessionId: string, projectId: string, inviterId: string, recipientId: string): Promise<LiveInvitation> {
            const inserted = await tx.execute(sql`
              INSERT INTO live_invitations (id, workspace_id, project_id, session_id, inviter_id, recipient_id)
              SELECT ${randomUUID()}, s.workspace_id, s.project_id, s.id, ${inviterId}, ${recipientId}
                FROM live_sessions s WHERE s.id = ${sessionId} AND s.project_id = ${projectId}
              ON CONFLICT (session_id, recipient_id) DO NOTHING
              RETURNING ${columns}, workspace_id
            `);
            const created = inserted.rows[0] as unknown as (InvitationRow & { workspace_id: string }) | undefined;
            if (created) {
              // Only a new row notifies: a repeated or concurrent invite converges on the
              // existing row above and records nothing. Identifiers only, never titles. This
              // is the command's last write (see recordEvent: the seq lock is held to commit).
              await recordEvent(eventPorts(tx), { kind: 'human', id: inviterId }, created.workspace_id, LIVE_INVITED_EVENT, created.project_id,
                { sessionId: created.session_id, invitationId: created.id, recipientId: created.recipient_id });
              return record(created);
            }
            const row = ((await tx.execute(sql`
              SELECT ${columns} FROM live_invitations
              WHERE session_id = ${sessionId} AND recipient_id = ${recipientId}
            `)).rows[0]) as unknown as InvitationRow | undefined;
            if (!row) throw new Error('Live invitation insert or unique-key retry returned no row');
            return record(row);
          },
          async find(invitationId: string): Promise<LiveInvitation | null> {
            const result = await tx.execute(sql`
              SELECT ${columns} FROM live_invitations WHERE id = ${invitationId}
            `);
            const row = result.rows[0] as unknown as InvitationRow | undefined;
            return row ? record(row) : null;
          },
          async respondIfPending(invitationId: string, recipientId: string, choice: 'later' | 'text'): Promise<LiveInvitation> {
            const updated = await tx.execute(sql`
              UPDATE live_invitations SET response = ${choice}, responded_at = now()
              WHERE id = ${invitationId} AND recipient_id = ${recipientId} AND response = 'pending'
              RETURNING ${columns}
            `);
            const row = (updated.rows[0] ?? (await tx.execute(sql`
              SELECT ${columns} FROM live_invitations
              WHERE id = ${invitationId} AND recipient_id = ${recipientId}
            `)).rows[0]) as unknown as InvitationRow | undefined;
            if (!row) throw new NotFoundError('Live invitation', 'LIVE_INVITATION_NOT_FOUND');
            return record(row);
          },
        };
        return work(access, invitations);
      });
    },
  };
}
