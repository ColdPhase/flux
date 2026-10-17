import { and, eq, gt, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { schema } from '@flux/db';
import { assertAuthorized, createNotification, isUuid, NotFoundError, type Database, type Principal } from '@flux/core';
import { notificationUnitOfWork, pgBossQueue } from '../push/adapters.js';

/**
 * "Tell whoever runs Flux" (F-027 AST-10 Journey 6): when this Flux does not allow signing in with a subscription (or has no free place
 * for it), one Needs-you item goes to the workspace's owners, who are the ones who can turn it on with `./flux ai on`. The same ask is
 * not sent twice within a week to the same owner, and the asker never gets their own item.
 */
export function assistantOperatorUseCases(db: Database, boss: Pick<PgBoss, 'send'>) {
  return {
    request(principal: Principal, workspaceId: string, plan: 'Claude' | 'ChatGPT') {
      if (principal.kind !== 'human' || !isUuid(workspaceId)) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
      return db.transaction(async (tx) => {
        await assertAuthorized(principal, 'workspace.read', { type: 'workspace', id: workspaceId }, tx);
        const [asker] = await tx.select({ name: schema.authUsers.name }).from(schema.authUsers).where(eq(schema.authUsers.id, principal.id));
        const first = (asker?.name ?? 'Someone').trim().split(/\s+/)[0] || 'Someone';
        const title = `${first} would like to use their ${plan} plan here`.slice(0, 200);
        const body = 'Whoever runs this Flux turns it on with ./flux ai on.';
        const owners = await tx.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, 'owner'))).orderBy(schema.workspaceMembers.userId);
        let sent = 0;
        for (const owner of owners) {
          if (owner.userId === principal.id) continue;
          const [already] = await tx.select({ id: schema.notifications.id }).from(schema.notifications).where(and(
            eq(schema.notifications.userId, owner.userId), eq(schema.notifications.title, title), eq(schema.notifications.sourceId, workspaceId),
            gt(schema.notifications.createdAt, sql`now() - interval '7 days'`))).limit(1);
          if (already) continue;
          const made = await createNotification(notificationUnitOfWork(tx, pgBossQueue(boss)), { userId: owner.userId, source: { type: 'workspace', id: workspaceId }, title, body });
          await tx.update(schema.notifications).set({ reason: 'question' }).where(eq(schema.notifications.id, made.id));
          sent += 1;
        }
        return { sent };
      });
    },
  };
}
