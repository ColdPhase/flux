import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';

/**
 * Operator re-key and provider unlink (F-024 S5b, #315). Both write an audit row in the same transaction. Neither
 * matches by email: an account is named by its Flux id, and a provider subject is taken as the operator or the
 * person's own provider sign-in proved it.
 */

export type IdentityMode = 'prepare' | 'sso';
export type IdentityAdminCode = 'SSO_MODE' | 'NO_ACCOUNT' | 'SUBJECT_HELD' | 'NOT_LINKED' | 'LAST_IDENTITY';

export class IdentityAdminError extends Error {
  constructor(readonly code: IdentityAdminCode, message: string) { super(message); }
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Ends every MCP connection, refresh grant and access token of the account, as the claim release does (#313). */
async function revokeMcpAuthority(tx: Tx, userId: string, at: Date) {
  const stamp = at.toISOString();
  await tx.execute(sql`UPDATE agent_connections SET revoked_at = ${stamp}::timestamptz, updated_at = ${stamp}::timestamptz
    WHERE owner_user_id = ${userId} AND revoked_at IS NULL`);
  await tx.execute(sql`UPDATE oauth_refresh_token SET revoked = ${stamp}::timestamptz WHERE user_id = ${userId} AND revoked IS NULL`);
  await tx.execute(sql`DELETE FROM oauth_access_token WHERE user_id = ${userId}`);
}

async function audit(tx: Tx, row: { action: 'rekey' | 'unlink'; userId: string; providerId: string; oldSubject: string | null;
  newSubject: string | null; actor: string; reason: string; mode: IdentityMode; at: Date }) {
  await tx.insert(schema.authIdentityAudit).values({ id: randomUUID(), createdAt: row.at, action: row.action, userId: row.userId,
    providerId: row.providerId, oldSubject: row.oldSubject, newSubject: row.newSubject, actor: row.actor.slice(0, 200),
    reason: row.reason.slice(0, 500), mode: row.mode });
}

export interface RekeyInput {
  userId: string; providerId: string; subject: string; actor: string; reason: string;
  mode: IdentityMode; allowInSso: boolean; now?: () => Date;
}

/**
 * Points the account's provider identity at `subject`. A subject another account holds is refused. A different
 * subject the account held before is replaced, and that account's sessions and MCP authority end: the re-key moves
 * the identity, not the data. In SSO-only mode the operator must pass `allowInSso` explicitly.
 */
export async function rekeyIdentity(db: Database, input: RekeyInput): Promise<'linked' | 'rekeyed' | 'unchanged'> {
  if (input.mode === 'sso' && !input.allowInSso) {
    throw new IdentityAdminError('SSO_MODE', 'Re-keying in SSO-only mode needs the explicit --allow-sso flag');
  }
  const at = (input.now ?? (() => new Date()))();
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: schema.authUsers.id }).from(schema.authUsers).where(eq(schema.authUsers.id, input.userId)).for('update');
    if (!user) throw new IdentityAdminError('NO_ACCOUNT', 'No account has that id');
    const [holder] = await tx.select({ userId: schema.authAccounts.userId }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.providerId, input.providerId), eq(schema.authAccounts.accountId, input.subject)));
    if (holder && holder.userId !== input.userId) throw new IdentityAdminError('SUBJECT_HELD', 'That provider identity belongs to another account');
    const [current] = await tx.select().from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, input.userId), eq(schema.authAccounts.providerId, input.providerId)));
    if (current && current.accountId === input.subject) return 'unchanged' as const;
    const base = { userId: input.userId, providerId: input.providerId, actor: input.actor, reason: input.reason, mode: input.mode, at };
    if (current) {
      await tx.update(schema.authAccounts).set({ accountId: input.subject }).where(eq(schema.authAccounts.id, current.id));
      await tx.delete(schema.authSessions).where(eq(schema.authSessions.userId, input.userId));
      await revokeMcpAuthority(tx, input.userId, at);
      await audit(tx, { ...base, action: 'rekey', oldSubject: current.accountId, newSubject: input.subject });
      return 'rekeyed' as const;
    }
    await tx.insert(schema.authAccounts).values({ id: randomUUID(), userId: input.userId, accountId: input.subject, providerId: input.providerId });
    await audit(tx, { ...base, action: 'rekey', oldSubject: null, newSubject: input.subject });
    return 'linked' as const;
  });
}

export interface UnlinkInput { userId: string; providerId: string; mode: IdentityMode; actor: string; reason: string; now?: () => Date }

/**
 * Removes the provider identity from an account, unless it is the account's last way to sign in. With SSO-only mode
 * the provider is the only way, so its link cannot go; in prepare mode a password on the account is the way back.
 * The sessions that signed in through this identity end, and so does the account's MCP authority.
 */
export async function unlinkIdentity(db: Database, input: UnlinkInput): Promise<void> {
  const at = (input.now ?? (() => new Date()))();
  await db.transaction(async (tx) => {
    const [link] = await tx.select({ id: schema.authAccounts.id, accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, input.userId), eq(schema.authAccounts.providerId, input.providerId))).for('update');
    if (!link) throw new IdentityAdminError('NOT_LINKED', 'This account has no link to that provider');
    const [password] = await tx.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, input.userId), eq(schema.authAccounts.providerId, 'credential'), sql`${schema.authAccounts.password} IS NOT NULL`));
    const passwordUsable = input.mode === 'prepare' && password !== undefined;
    if (!passwordUsable) throw new IdentityAdminError('LAST_IDENTITY', 'That is the last way to sign in to this account; it cannot be removed');
    await tx.execute(sql`DELETE FROM auth_sessions WHERE user_id = ${input.userId}
      AND id IN (SELECT session_id FROM auth_session_identities WHERE method = ${input.providerId})`);
    await revokeMcpAuthority(tx, input.userId, at);
    await tx.delete(schema.authAccounts).where(eq(schema.authAccounts.id, link.id));
    await audit(tx, { action: 'unlink', userId: input.userId, providerId: input.providerId, oldSubject: link.accountId, newSubject: null,
      actor: input.actor, reason: input.reason, mode: input.mode, at });
  });
}
