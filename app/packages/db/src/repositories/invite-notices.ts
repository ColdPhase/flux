import { eq, inArray } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** The notice an invite's creator gets when the link is used (#763 FT-3): the new person's name, and a Needs-you question. */
export function inviteNoticeRows(tx: DbExecutor) {
  return {
    async names(userIds: string[]) {
      if (!userIds.length) return new Map<string, string>();
      return new Map((await tx.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers)
        .where(inArray(schema.authUsers.id, userIds))).map((row) => [row.id, row.name]));
    },
    /** Giving the new person access is the one thing left to do: it waits in Needs you. */
    async markQuestion(notificationId: string) {
      await tx.update(schema.notifications).set({ reason: 'question' }).where(eq(schema.notifications.id, notificationId));
    },
  };
}
