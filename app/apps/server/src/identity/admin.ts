import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import { oidcProviderId } from './config.js';

/**
 * Operator re-key and provider unlink (F-024 S5b, #315). Both write an audit row in the same transaction. Neither
 * matches by email: an account is named by its Flux id, and a provider subject is taken as the operator or the
 * person's own provider sign-in proved it.
 */

export type IdentityMode = 'prepare' | 'sso';
export type IdentityAdminCode = 'SSO_MODE' | 'NO_ACCOUNT' | 'SUBJECT_HELD' | 'NOT_LINKED' | 'LAST_IDENTITY'
  | 'INVALID_ISSUER' | 'OLD_ISSUER_REQUIRED' | 'OLD_IDENTITY_MISMATCH' | 'ISSUER_COLLISION' | 'IDENTITY_AMBIGUOUS';

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
  newSubject: string | null; oldIssuer: string | null; newIssuer: string | null; actor: string; reason: string; mode: IdentityMode; at: Date }) {
  await tx.insert(schema.authIdentityAudit).values({ id: randomUUID(), createdAt: row.at, action: row.action, userId: row.userId,
    providerId: row.providerId, oldIssuer: row.oldIssuer, newIssuer: row.newIssuer, oldSubject: row.oldSubject, newSubject: row.newSubject, actor: row.actor.slice(0, 200),
    reason: row.reason.slice(0, 500), mode: row.mode });
}

/** Validate a CLI-supplied historical issuer without contacting that issuer. */
function canonicalIssuer(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new IdentityAdminError('INVALID_ISSUER', 'Issuer must be an absolute HTTP(S) URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new IdentityAdminError('INVALID_ISSUER', 'Issuer must be an HTTP(S) URL without credentials, query or fragment');
  }
  return trimmed.replace(/\/$/, '');
}

export interface RekeyInput {
  userId: string; providerId: string; issuer: string; oldIssuer?: string; subject: string; actor: string; reason: string;
  mode: IdentityMode; allowInSso: boolean; now?: () => Date;
}

/**
 * Points the account's provider identity at `subject`. A subject another account holds is refused. A different
 * subject the account held before is replaced, and that account's sessions and MCP authority end: the re-key moves
 * the identity, not the data. In SSO-only mode the operator must pass `allowInSso` explicitly.
 */
const uniqueViolation = (error: unknown) => {
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } } | null;
  const cause = candidate?.cause;
  return (candidate?.code ?? cause?.code) === '23505'
    && (candidate?.constraint ?? cause?.constraint) === 'auth_accounts_provider_account_idx';
};

export async function rekeyIdentity(db: Database, input: RekeyInput): Promise<'linked' | 'rekeyed' | 'unchanged'> {
  if (input.mode === 'sso' && !input.allowInSso) {
    throw new IdentityAdminError('SSO_MODE', 'Re-keying in SSO-only mode needs the explicit --allow-sso flag');
  }
  const issuer = canonicalIssuer(input.issuer);
  if (oidcProviderId(issuer) !== input.providerId) throw new IdentityAdminError('INVALID_ISSUER', 'Configured issuer does not match its provider id');
  const oldIssuer = input.oldIssuer === undefined ? undefined : canonicalIssuer(input.oldIssuer);
  const oldProviderId = oldIssuer === undefined ? undefined : oidcProviderId(oldIssuer);
  if (oldIssuer !== undefined && oldProviderId === input.providerId && oldIssuer !== issuer) {
    throw new IdentityAdminError('ISSUER_COLLISION', 'The old and configured issuer values collide on the provider id; refusing an ambiguous re-key');
  }
  const at = (input.now ?? (() => new Date()))();
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.select({ id: schema.authUsers.id }).from(schema.authUsers).where(eq(schema.authUsers.id, input.userId)).for('update');
      if (!user) throw new IdentityAdminError('NO_ACCOUNT', 'No account has that id');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.providerId + ':' + input.subject}, 0))`);
      const [holder] = await tx.select({ userId: schema.authAccounts.userId }).from(schema.authAccounts)
        .where(and(eq(schema.authAccounts.providerId, input.providerId), eq(schema.authAccounts.accountId, input.subject)));
      if (holder && holder.userId !== input.userId) throw new IdentityAdminError('SUBJECT_HELD', 'That provider identity belongs to another account');
      const providerLinks = await tx.select({ id: schema.authAccounts.id, providerId: schema.authAccounts.providerId,
        accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
        .where(and(eq(schema.authAccounts.userId, input.userId), ne(schema.authAccounts.providerId, 'credential'))).for('update');
      let current: typeof providerLinks[number] | undefined;
      let sourceProviderId: string | undefined;
      if (oldProviderId !== undefined) {
        if (providerLinks.length !== 1 || providerLinks[0].providerId !== oldProviderId) {
          throw new IdentityAdminError('OLD_IDENTITY_MISMATCH', 'The named account does not have exactly one provider identity matching --old-issuer');
        }
        current = providerLinks[0];
        sourceProviderId = oldProviderId;
      } else {
        const active = providerLinks.find((row) => row.providerId === input.providerId);
        if (providerLinks.length > 1) throw new IdentityAdminError('IDENTITY_AMBIGUOUS', 'The account has multiple provider identities; refusing an ambiguous re-key');
        if (providerLinks.length === 1 && !active) {
          throw new IdentityAdminError('OLD_ISSUER_REQUIRED', 'The account is linked to a different issuer; provide its exact value with --old-issuer');
        }
        current = active;
        sourceProviderId = active?.providerId;
      }
      if (current && current.providerId === input.providerId && current.accountId === input.subject) return 'unchanged' as const;
      const base = { userId: input.userId, providerId: input.providerId, actor: input.actor, reason: input.reason, mode: input.mode, at,
        oldIssuer: current ? (oldIssuer ?? issuer) : null, newIssuer: issuer };
      if (current) {
        await tx.update(schema.authAccounts).set({ accountId: input.subject, providerId: input.providerId, accessToken: null, refreshToken: null,
          idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scope: null, confirmedAt: null })
          .where(eq(schema.authAccounts.id, current.id));
        await tx.delete(schema.authSessions).where(eq(schema.authSessions.userId, input.userId));
        await revokeMcpAuthority(tx, input.userId, at);
        await tx.delete(schema.authIdpStanding).where(and(eq(schema.authIdpStanding.userId, input.userId),
          inArray(schema.authIdpStanding.providerId, [...new Set([sourceProviderId!, input.providerId])])));
        await audit(tx, { ...base, action: 'rekey', oldSubject: current.accountId, newSubject: input.subject });
        return 'rekeyed' as const;
      }
      await tx.insert(schema.authAccounts).values({ id: randomUUID(), userId: input.userId, accountId: input.subject, providerId: input.providerId });
      await audit(tx, { ...base, oldIssuer: null, action: 'rekey', oldSubject: null, newSubject: input.subject });
      return 'linked' as const;
    });
  } catch (error) {
    // Ordinary provider sign-in does not take this admin lock. It may commit a target identity after our holder read
    // and win the unique index while this transaction moves the named account. Preserve the same refusal semantics.
    if (uniqueViolation(error)) throw new IdentityAdminError('SUBJECT_HELD', 'That provider identity belongs to another account');
    throw error;
  }
}

export interface UnlinkInput { userId: string; providerId: string; issuer: string; mode: IdentityMode; actor: string; reason: string; now?: () => Date }

/**
 * Removes the provider identity from an account, unless it is the account's last way to sign in. With SSO-only mode
 * the provider is the only way, so its link cannot go; in prepare mode a password on the account is the way back.
 * The sessions that signed in through this identity end, and so does the account's MCP authority.
 */
export async function unlinkIdentity(db: Database, input: UnlinkInput): Promise<void> {
  const issuer = canonicalIssuer(input.issuer);
  if (oidcProviderId(issuer) !== input.providerId) throw new IdentityAdminError('INVALID_ISSUER', 'Configured issuer does not match its provider id');
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
    await tx.delete(schema.authIdpStanding).where(and(eq(schema.authIdpStanding.userId, input.userId), eq(schema.authIdpStanding.providerId, input.providerId)));
    await tx.delete(schema.authAccounts).where(eq(schema.authAccounts.id, link.id));
    await audit(tx, { action: 'unlink', userId: input.userId, providerId: input.providerId, oldIssuer: issuer, newIssuer: null, oldSubject: link.accountId, newSubject: null,
      actor: input.actor, reason: input.reason, mode: input.mode, at });
  });
}
