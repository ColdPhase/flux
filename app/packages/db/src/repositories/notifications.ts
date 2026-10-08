import { messagePreview } from '@flux/contracts';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle rows for notification generation, preferences, delivery addresses and the email
 * outbox (issue #116). They satisfy the ports in `packages/core/src/notifications/ports.ts`
 * structurally (this package does not depend on core) and make no access decisions: the core
 * use cases ask the access policy before anything reaches a person.
 */

const n = schema.notifications;
const e = schema.events;
const p = schema.notificationPreferences;
const m = schema.notificationMutes;
const a = schema.notificationAddresses;
const t = schema.notificationAddressTokens;
const ob = schema.notificationEmails;
const CURSOR = 'generator';

type Reason = 'mention' | 'question' | 'reply' | 'dm' | 'assigned' | 'review' | 'invitation';
type SourceType = 'workspace' | 'project' | 'draft' | 'dm';

export interface StoredPreferenceRow {
  channels: Record<string, Record<string, boolean>>;
  emailDestination: 'account' | 'extra' | 'both' | 'none';
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  timeZone: string;
}

/** What the generator reads and writes inside its transaction. */
export function notificationGeneratorRows(db: DbExecutor) {
  return {
    async lockCursor() {
      const [row] = await db.select({ seq: schema.notificationCursor.seq }).from(schema.notificationCursor)
        .where(eq(schema.notificationCursor.id, CURSOR)).for('update');
      if (row) return row.seq;
      await db.insert(schema.notificationCursor).values({ id: CURSOR, seq: 0 }).onConflictDoNothing();
      const [created] = await db.select({ seq: schema.notificationCursor.seq }).from(schema.notificationCursor)
        .where(eq(schema.notificationCursor.id, CURSOR)).for('update');
      return created!.seq;
    },
    async advanceCursor(seq: number) {
      await db.update(schema.notificationCursor).set({ seq }).where(and(eq(schema.notificationCursor.id, CURSOR), sql`${schema.notificationCursor.seq} < ${seq}`));
    },
    async eventsAfter(seq: number, limit: number) {
      const rows = await db.select({ id: e.id, seq: e.seq, kind: e.kind, workspaceId: e.workspaceId, objectId: e.objectId, actorId: e.actorId, data: e.data })
        .from(e).where(and(gt(e.seq, seq), isNotNull(e.workspaceId))).orderBy(asc(e.seq)).limit(limit);
      return rows.map((row) => ({ ...row, workspaceId: row.workspaceId!, data: (row.data ?? {}) as Record<string, unknown> }));
    },
    async insertNotification(row: {
      id: string; userId: string; source: { workspaceId: string; type: SourceType; id: string }; reason: Reason; eventId: string;
      title: string; body: string; url: string; inInbox: boolean;
    }) {
      const inserted = await db.insert(n).values({
        id: row.id, userId: row.userId, workspaceId: row.source.workspaceId, sourceType: row.source.type, sourceId: row.source.id,
        reason: row.reason, eventId: row.eventId, title: row.title, body: row.body, url: row.url, inInbox: row.inInbox,
      }).onConflictDoNothing({ target: [n.userId, n.eventId], where: sql`${n.eventId} IS NOT NULL` }).returning({ id: n.id });
      return inserted.length > 0;
    },
    async emailedRecently(userId: string, source: { type: string; id: string }, since: Date) {
      const rows = await db.select({ id: ob.id }).from(ob).innerJoin(n, eq(n.id, ob.notificationId))
        .where(and(eq(ob.userId, userId), eq(n.sourceType, source.type as SourceType), eq(n.sourceId, source.id), gte(ob.createdAt, since))).limit(1);
      return rows.length > 0;
    },
    async recordFailure(eventId: string, error: string) {
      const f = schema.notificationGenerationFailures;
      const [row] = await db.insert(f).values({ eventId, attempts: 1, lastError: error.slice(0, 500) })
        .onConflictDoUpdate({ target: f.eventId, set: { attempts: sql`${f.attempts} + 1`, lastError: error.slice(0, 500), updatedAt: sql`now()` } })
        .returning({ attempts: f.attempts });
      return row!.attempts;
    },
    async deadLetter(eventId: string) {
      const f = schema.notificationGenerationFailures;
      await db.update(f).set({ deadAt: sql`now()` }).where(eq(f.eventId, eventId));
    },
    async insertEmail(row: { id: string; notificationId: string; userId: string; addressKind: 'account' | 'extra' }) {
      const inserted = await db.insert(ob).values(row).onConflictDoNothing().returning({ id: ob.id });
      return inserted.length > 0;
    },
  };
}

/** Current domain rows that explain an event. */
export function notificationFactRows(db: DbExecutor) {
  const names = async (userIds: string[]) => {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Map<string, string>();
    const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  };
  const projectName = async (projectId: string) => {
    const [row] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId));
    return row?.name ?? 'a project';
  };
  const workOwners = async (ids: string[]) => {
    if (!ids.length) return [];
    const rows = await db.selectDistinct({ owner: schema.projectWorkItems.ownerUserId }).from(schema.projectWorkItems)
      .where(and(inArray(schema.projectWorkItems.id, ids), isNotNull(schema.projectWorkItems.ownerUserId)));
    return rows.map((row) => row.owner!);
  };
  const linkedWork = async (fromId: string, role: 'affects' | 'about') => {
    const rows = await db.select({ id: schema.projectObjectLinks.toId }).from(schema.projectObjectLinks)
      .where(and(eq(schema.projectObjectLinks.fromId, fromId), eq(schema.projectObjectLinks.role, role), eq(schema.projectObjectLinks.toType, 'work')));
    return rows.map((row) => row.id);
  };
  const agentOwner = async (kind: string, id: string) => {
    if (kind !== 'agent') return null;
    const [row] = await db.select({ owner: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, id));
    return row?.owner ?? null;
  };
  return {
    names,
    async audience(eventId: string) {
      const rows = await db.select({ recipient: schema.eventAudience.recipient }).from(schema.eventAudience)
        .where(and(eq(schema.eventAudience.eventId, eventId), sql`${schema.eventAudience.recipient} LIKE 'human:%'`));
      return rows.map((row) => row.recipient.slice('human:'.length));
    },
    async projectMessage(messageId: string) {
      const pm = schema.projectMessages;
      const [row] = await db.select({ message: pm, createdBy: schema.projectConversations.createdBy, createdByAgentId: schema.projectConversations.createdByAgentId }).from(pm)
        .innerJoin(schema.projectConversations, eq(schema.projectConversations.id, pm.conversationId)).where(eq(pm.id, messageId));
      if (!row) return null;
      const message = row.message;
      const [opening] = await db.select({ body: pm.body, attachmentCount: pm.attachmentCount }).from(pm).where(eq(pm.conversationId, message.conversationId)).orderBy(asc(pm.sequence)).limit(1);
      const earlier = await db.selectDistinct({ authorId: pm.authorId }).from(pm)
        .where(and(eq(pm.conversationId, message.conversationId), sql`${pm.sequence} < ${message.sequence}`, isNotNull(pm.authorId)));
      const [agent] = message.authorAgentId ? await db.select({ name: schema.agents.name }).from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, message.workspaceId), eq(schema.agents.id, message.authorAgentId))) : [];
      const [asked] = await db.select({ userId: schema.agentQuestions.askedUserId, question: schema.agentQuestions.question }).from(schema.agentQuestions)
        .where(eq(schema.agentQuestions.messageId, message.id));
      return {
        asked: asked ?? null,
        id: message.id, workspaceId: message.workspaceId, projectId: message.projectId, projectName: await projectName(message.projectId),
        conversationId: message.conversationId, opening: messagePreview(opening?.body ?? message.body, opening?.attachmentCount ?? message.attachmentCount), conversationCreatedBy: row.createdBy !== null ? { kind: 'human' as const, id: row.createdBy } : { kind: 'agent' as const, id: row.createdByAgentId! },
        author: message.authorId !== null ? { kind: 'human' as const, id: message.authorId } : { kind: 'agent' as const, id: message.authorAgentId! },
        authorName: agent?.name ?? null, body: message.body, attachmentCount: message.attachmentCount, sequence: message.sequence, earlierAuthors: earlier.map((item) => item.authorId!),
      };
    },
    async dmMessage(dmId: string, messageId: string) {
      const [row] = await db.select({ message: schema.dmMessages, dm: schema.dms }).from(schema.dmMessages)
        .innerJoin(schema.dms, eq(schema.dms.id, schema.dmMessages.dmId))
        .where(and(eq(schema.dmMessages.id, messageId), eq(schema.dmMessages.dmId, dmId)));
      if (!row) return null;
      const participants = await db.select({ id: schema.dmParticipants.userId }).from(schema.dmParticipants).where(eq(schema.dmParticipants.dmId, dmId));
      return {
        id: row.message.id, workspaceId: row.dm.workspaceId, dmId, kind: row.dm.kind as 'pair' | 'group', title: row.dm.title,
        authorId: row.message.authorId, body: row.message.body, participantIds: participants.map((item) => item.id),
      };
    },
    async work(workId: string) {
      const w = schema.projectWorkItems;
      const [row] = await db.select({ id: w.id, projectId: w.projectId, title: w.title, ownerUserId: w.ownerUserId }).from(w).where(eq(w.id, workId));
      return row ? { ...row, projectName: await projectName(row.projectId) } : null;
    },
    async decision(decisionId: string) {
      const d = schema.projectDecisions;
      const [row] = await db.select({ id: d.id, projectId: d.projectId, title: d.title, kind: d.proposedByKind, by: d.proposedById }).from(d).where(eq(d.id, decisionId));
      if (!row) return null;
      return {
        id: row.id, projectId: row.projectId, projectName: await projectName(row.projectId), title: row.title,
        by: { kind: row.kind as 'human' | 'agent', id: row.by }, workOwners: await workOwners(await linkedWork(row.id, 'affects')), agentOwner: await agentOwner(row.kind, row.by),
      };
    },
    async result(resultId: string) {
      const r = schema.projectResults;
      const [row] = await db.select({ id: r.id, projectId: r.projectId, title: r.title, kind: r.createdByKind, by: r.createdById }).from(r).where(eq(r.id, resultId));
      if (!row) return null;
      return {
        id: row.id, projectId: row.projectId, projectName: await projectName(row.projectId), title: row.title,
        by: { kind: row.kind as 'human' | 'agent', id: row.by }, workOwners: await workOwners(await linkedWork(row.id, 'about')), agentOwner: await agentOwner(row.kind, row.by),
      };
    },
    /** A pending invitation of an available session, with its anchor's project-level label (#62). */
    async liveInvitation(invitationId: string) {
      const li = schema.liveInvitations;
      const ls = schema.liveSessions;
      const [row] = await db.select({ invitation: li, session: ls }).from(li)
        .innerJoin(ls, and(eq(ls.id, li.sessionId), eq(ls.projectId, li.projectId), eq(ls.workspaceId, li.workspaceId)))
        .where(eq(li.id, invitationId));
      if (!row || row.invitation.response !== 'pending' || row.session.state !== 'available') return null;
      const { session } = row;
      let anchor: { type: 'conversation' | 'work' | 'sketch' | 'doc'; label: string } | null = null;
      if (session.conversationId) {
        const pm = schema.projectMessages;
        const [opening] = await db.select({ body: pm.body, attachmentCount: pm.attachmentCount }).from(pm)
          .where(and(eq(pm.conversationId, session.conversationId), eq(pm.projectId, session.projectId))).orderBy(asc(pm.sequence)).limit(1);
        if (opening) anchor = { type: 'conversation', label: messagePreview(opening.body, opening.attachmentCount) };
      } else if (session.workId) {
        const w = schema.projectWorkItems;
        const [work] = await db.select({ title: w.title }).from(w).where(and(eq(w.id, session.workId), eq(w.projectId, session.projectId)));
        if (work) anchor = { type: 'work', label: work.title };
      } else if (session.sketchId) {
        const sk = schema.sketches;
        const [sketch] = await db.select({ title: sk.title, scope: sk.scope }).from(sk).where(and(eq(sk.id, session.sketchId), eq(sk.projectId, session.projectId)));
        // A private sketch never anchors a project session; never show its title.
        if (sketch && sketch.scope === 'project') anchor = { type: 'sketch', label: sketch.title };
      } else if (session.docId) {
        const pmat = schema.projectMaterials;
        const v = schema.projectMaterialVersions;
        const [doc] = await db.select({ title: v.title }).from(pmat)
          .innerJoin(v, and(eq(v.materialId, pmat.id), eq(v.version, pmat.currentVersion)))
          .where(and(eq(pmat.id, session.docId), eq(pmat.projectId, session.projectId), eq(pmat.kind, 'doc')));
        if (doc) anchor = { type: 'doc', label: doc.title };
      }
      if (!anchor) return null;
      return {
        id: row.invitation.id, sessionId: session.id, projectId: session.projectId, projectName: await projectName(session.projectId),
        inviterId: row.invitation.inviterId, recipientId: row.invitation.recipientId, anchor,
      };
    },
  };
}

/** Stored preferences and mutes (`PreferenceStore`). */
export function notificationPreferenceRows(db: DbExecutor) {
  return {
    async find(userId: string): Promise<StoredPreferenceRow | null> {
      const [row] = await db.select().from(p).where(eq(p.userId, userId));
      if (!row) return null;
      return { channels: row.channels ?? {}, emailDestination: row.emailDestination, quietEnabled: row.quietEnabled, quietStart: row.quietStart, quietEnd: row.quietEnd, timeZone: row.timeZone };
    },
    async save(userId: string, values: StoredPreferenceRow) {
      const set = { ...values, updatedAt: new Date() };
      await db.insert(p).values({ userId, ...set }).onConflictDoUpdate({ target: p.userId, set });
    },
    /** The row locked FOR UPDATE, created with the column defaults when missing. Use inside a transaction. */
    async lock(userId: string): Promise<StoredPreferenceRow> {
      await db.insert(p).values({ userId }).onConflictDoNothing();
      const [row] = await db.select().from(p).where(eq(p.userId, userId)).for('update');
      return { channels: row!.channels ?? {}, emailDestination: row!.emailDestination, quietEnabled: row!.quietEnabled, quietStart: row!.quietStart, quietEnd: row!.quietEnd, timeZone: row!.timeZone };
    },
    async isMuted(userId: string, source: { type: string; id: string }) {
      if (source.type !== 'project' && source.type !== 'dm') return false;
      const rows = await db.select({ id: m.sourceId }).from(m).where(and(eq(m.userId, userId), eq(m.sourceType, source.type), eq(m.sourceId, source.id)));
      return rows.length > 0;
    },
    async mutes(userId: string) {
      const rows = await db.select({ type: m.sourceType, id: m.sourceId }).from(m).where(eq(m.userId, userId)).orderBy(asc(m.createdAt));
      return rows;
    },
    async setMuted(userId: string, source: { type: 'project' | 'dm'; id: string }, muted: boolean) {
      if (muted) await db.insert(m).values({ userId, sourceType: source.type, sourceId: source.id }).onConflictDoNothing();
      else await db.delete(m).where(and(eq(m.userId, userId), eq(m.sourceType, source.type), eq(m.sourceId, source.id)));
    },
  };
}

/** Names of projects and DMs for the muted list; the caller decides which ones may be shown. */
export function notificationPlaceRows(db: DbExecutor) {
  return {
    async projectNames(ids: string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, ids));
      return new Map(rows.map((row) => [row.id, row.name]));
    },
    /** A group's title, or the other participants' names. */
    async dmNames(ids: string[], userId: string) {
      if (!ids.length) return new Map<string, string>();
      const dms = await db.select({ id: schema.dms.id, title: schema.dms.title }).from(schema.dms).where(inArray(schema.dms.id, ids));
      const people = await db.select({ dmId: schema.dmParticipants.dmId, name: schema.authUsers.name }).from(schema.dmParticipants)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.dmParticipants.userId))
        .where(and(inArray(schema.dmParticipants.dmId, ids), ne(schema.dmParticipants.userId, userId))).orderBy(asc(schema.authUsers.name));
      return new Map(dms.map((dm) => [dm.id, dm.title ?? (people.filter((row) => row.dmId === dm.id).map((row) => row.name).join(', ') || 'Direct message')]));
    },
  };
}

type AddressRow = typeof a.$inferSelect;
const addressRecord = (row: AddressRow) => ({ id: row.id, userId: row.userId, email: row.email, verifiedAt: row.verifiedAt, lastSentAt: row.lastSentAt });

/** The extra delivery address and its verification tokens (`AddressRepository`). */
export function notificationAddressRows(db: DbExecutor) {
  return {
    async find(userId: string) {
      const [row] = await db.select().from(a).where(eq(a.userId, userId));
      return row ? addressRecord(row) : null;
    },
    async replace(userId: string, id: string, email: string) {
      await db.delete(a).where(eq(a.userId, userId));
      const [row] = await db.insert(a).values({ id, userId, email }).returning();
      return addressRecord(row!);
    },
    async remove(userId: string) {
      return (await db.delete(a).where(eq(a.userId, userId)).returning({ id: a.id })).length > 0;
    },
    /**
     * Reserves one verification send for the person, or answers how long to wait. A single
     * conditional upsert (row-locked by ON CONFLICT) enforces at least `cooldownSeconds` between
     * sends and at most `perWindow` per `windowSeconds`, so concurrent requests cannot both pass.
     */
    async reserveVerificationSend(userId: string, limits: { cooldownSeconds: number; perWindow: number; windowSeconds: number }) {
      const v = schema.notificationVerificationSends;
      const cooldown = sql`make_interval(secs => ${limits.cooldownSeconds})`;
      const window = sql`make_interval(secs => ${limits.windowSeconds})`;
      const reserved = await db.execute(sql`
        INSERT INTO ${v} (user_id, window_start, sent, last_sent_at) VALUES (${userId}, now(), 1, now())
        ON CONFLICT (user_id) DO UPDATE SET
          window_start = CASE WHEN ${v}.window_start <= now() - ${window} THEN now() ELSE ${v}.window_start END,
          sent = CASE WHEN ${v}.window_start <= now() - ${window} THEN 1 ELSE ${v}.sent + 1 END,
          last_sent_at = now()
        WHERE ${v}.last_sent_at <= now() - ${cooldown}
          AND (${v}.window_start <= now() - ${window} OR ${v}.sent < ${limits.perWindow})
        RETURNING user_id`);
      if (reserved.rows.length) return { allowed: true as const };
      const [row] = await db.select().from(v).where(eq(v.userId, userId));
      const now = Date.now();
      const untilCooldown = row ? row.lastSentAt.getTime() + limits.cooldownSeconds * 1000 - now : 0;
      const untilWindow = row && row.sent >= limits.perWindow ? row.windowStart.getTime() + limits.windowSeconds * 1000 - now : 0;
      return { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil(Math.max(untilCooldown, untilWindow) / 1000)) };
    },
    async issueToken(addressId: string, tokenHash: string, expiresAt: Date) {
      await db.delete(t).where(eq(t.addressId, addressId));
      await db.insert(t).values({ tokenHash, addressId, expiresAt });
      await db.update(a).set({ lastSentAt: sql`now()` }).where(eq(a.id, addressId));
    },
    /** Single use: the token row is deleted by the same statement that finds it. */
    async consumeToken(userId: string, tokenHash: string) {
      const consumed = await db.delete(t).where(and(
        eq(t.tokenHash, tokenHash), gt(t.expiresAt, sql`now()`),
        sql`EXISTS (SELECT 1 FROM ${a} WHERE ${a.id} = ${t.addressId} AND ${a.userId} = ${userId})`,
      )).returning({ addressId: t.addressId });
      const addressId = consumed[0]?.addressId;
      if (!addressId) return null;
      await db.delete(t).where(eq(t.addressId, addressId));
      const [row] = await db.update(a).set({ verifiedAt: sql`coalesce(${a.verifiedAt}, now())` }).where(eq(a.id, addressId)).returning();
      return row ? addressRecord(row) : null;
    },
  };
}

/** The email outbox as the sender and one-click unsubscribe use it. */
export function notificationEmailRows(db: DbExecutor) {
  return {
    async lockEmail(id: string) {
      const [target] = await db.select({ notificationId: ob.notificationId }).from(ob).where(eq(ob.id, id));
      if (!target) return null;
      // Lock the notification's copies in one order, so concurrent account/extra sends serialize.
      await db.select({ id: ob.id }).from(ob).where(eq(ob.notificationId, target.notificationId)).orderBy(ob.id).for('update');
      const [row] = await db.select({ email: ob, notification: n }).from(ob)
        .innerJoin(n, and(eq(n.id, ob.notificationId), eq(n.userId, ob.userId))).where(eq(ob.id, id)).for('update', { of: ob });
      if (!row) return null;
      return {
        id: row.email.id, userId: row.email.userId, addressKind: row.email.addressKind, status: row.email.status, attempts: row.email.attempts,
        notification: { id: row.notification.id, reason: row.notification.reason ?? null, source: { workspaceId: row.notification.workspaceId, type: row.notification.sourceType, id: row.notification.sourceId } },
      };
    },
    async mailboxClaimed(notificationId: string, exceptId: string, address: string) {
      const [row] = await db.select({ id: ob.id }).from(ob).where(and(eq(ob.notificationId, notificationId), ne(ob.id, exceptId),
        inArray(ob.status, ['sending', 'sent']), sql`lower(${ob.address}) = lower(${address})`)).limit(1);
      return !!row;
    },
    async accountAddress(userId: string) {
      const [row] = await db.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, userId));
      return row?.email ?? null;
    },
    async verifiedExtraAddress(userId: string) {
      const [row] = await db.select({ email: a.email }).from(a).where(and(eq(a.userId, userId), isNotNull(a.verifiedAt)));
      return row?.email ?? null;
    },
    async markSkipped(id: string, reason: string) {
      await db.update(ob).set({ status: 'skipped', skipReason: reason.slice(0, 200) }).where(eq(ob.id, id));
    },
    async markSending(id: string, address: string, unsubscribeHash: string) {
      await db.update(ob).set({ status: 'sending', address, unsubscribeHash, attempts: sql`${ob.attempts} + 1` }).where(and(eq(ob.id, id), eq(ob.status, 'queued')));
    },
    async markSent(id: string) {
      await db.update(ob).set({ status: 'sent', sentAt: sql`now()` }).where(eq(ob.id, id));
    },
    async requeue(id: string, error: string) {
      await db.update(ob).set({ status: 'queued', lastError: error.slice(0, 300), lastErrorAt: sql`now()` }).where(and(eq(ob.id, id), eq(ob.status, 'sending')));
    },
    async failPermanently(id: string, reason: string, error: string) {
      const rows = await db.update(ob).set({ status: 'skipped', skipReason: reason.slice(0, 200), lastError: error.slice(0, 300), lastErrorAt: sql`now()` })
        .where(and(eq(ob.id, id), eq(ob.status, 'sending'))).returning({ id: ob.id });
      return rows.length === 1;
    },
    async promoteSkippedCopy(notificationId: string, exceptId: string, skipReason: string) {
      const [sibling] = await db.select({ id: ob.id }).from(ob).where(and(eq(ob.notificationId, notificationId), ne(ob.id, exceptId),
        eq(ob.status, 'skipped'), eq(ob.skipReason, skipReason))).orderBy(ob.id).limit(1);
      if (!sibling) return null;
      const rows = await db.update(ob).set({ status: 'queued', skipReason: null })
        .where(and(eq(ob.id, sibling.id), eq(ob.status, 'skipped'), eq(ob.skipReason, skipReason))).returning({ id: ob.id });
      return rows[0]?.id ?? null;
    },
    /** When the person's most recent email that has not been sent last failed, if within `since`. */
    async lastFailure(userId: string, since: Date) {
      const [row] = await db.select({ at: ob.lastErrorAt }).from(ob)
        .where(and(eq(ob.userId, userId), ne(ob.status, 'sent'), isNotNull(ob.lastErrorAt), gte(ob.lastErrorAt, since)))
        .orderBy(sql`${ob.lastErrorAt} DESC`).limit(1);
      return row?.at ?? null;
    },
    async findByToken(tokenHash: string) {
      const [row] = await db.select({ userId: ob.userId, addressKind: ob.addressKind, address: ob.address }).from(ob).where(eq(ob.unsubscribeHash, tokenHash));
      return row ?? null;
    },
  };
}

/** Marks every unread inbox row read. */
export async function markAllNotificationsRead(db: DbExecutor, userId: string) {
  const rows = await db.update(n).set({ readAt: sql`now()` }).where(and(eq(n.userId, userId), isNull(n.readAt))).returning({ id: n.id });
  return rows.length;
}
