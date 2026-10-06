import { and, eq, gt, sql } from 'drizzle-orm';
import type { TypingContext } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** Native row/clock/notification primitives, not access decisions or a durable activity table. */
export function typingRows(db: DbExecutor) {
  return {
    async locate(context: TypingContext): Promise<{ projectId: string } | null> {
      if (context.kind === 'dm') return null;
      const table = context.kind === 'conversation' ? schema.projectConversations : schema.projectWorkItems;
      const [row] = await db.select({ projectId: table.projectId }).from(table).where(eq(table.id, context.id));
      return row ?? null;
    },
    async currentHuman(actor: { actorId: string; sessionId: string }): Promise<{ id: string; name: string } | null> {
      const [row] = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authSessions)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.authSessions.userId))
        .where(and(eq(schema.authSessions.id, actor.sessionId), eq(schema.authSessions.userId, actor.actorId),
          gt(schema.authSessions.expiresAt, sql`clock_timestamp()`)));
      return row ?? null;
    },
  };
}
export interface TypingNotificationInput {
  connectionId: string; actorId: string; sessionId: string; context: TypingContext; sequence: number; active: boolean;
}
const finite = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Typing database clock unavailable');
  return number;
};
/** Constant dedicated channel; no events/audience/messages/outbox/jobs or other row writes. */
export function typingNotifications(db: Pick<DbExecutor, 'execute'>) {
  return {
    async now(): Promise<number> {
      const result = await db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`);
      return finite(result.rows[0]?.now);
    },
    async publish(pulse: TypingNotificationInput, minimumExpiry: number) {
      if (!Number.isFinite(minimumExpiry) || minimumExpiry < 0) throw new Error('Invalid typing expiry fence');
      pulse = { connectionId: pulse.connectionId, actorId: pulse.actorId, sessionId: pulse.sessionId,
        context: { kind: pulse.context.kind, id: pulse.context.id }, sequence: pulse.sequence, active: pulse.active };
      const payload = JSON.stringify(pulse);
      if (Buffer.byteLength(payload, 'utf8') > 1800) throw new Error('Typing notification exceeds bound');
      const result = await db.execute(sql`WITH expiry AS (
        SELECT greatest(floor(extract(epoch FROM clock_timestamp()) * 1000) + 5000, ${minimumExpiry})::float8 AS value
      ) SELECT value, pg_notify('flux_typing', (${payload}::jsonb || jsonb_build_object('expiresAt', value))::text) FROM expiry`);
      return { ...pulse, context: { ...pulse.context }, expiresAt: finite(result.rows[0]?.value) };
    },
  };
}
