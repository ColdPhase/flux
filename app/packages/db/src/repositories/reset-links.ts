import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/**
 * Password reset links (#1471; docs/development/access-policy.md#password-reset-links-1471). A link's token is a Better Auth
 * `reset-password:` verification value (`auth_verifications`, its identifier stored hashed); `password_reset_links` records each link by
 * that hashed identifier, so a newer link or the use of one can stop the account's other links. Nothing here holds a token.
 */
export type ResetLinkVia = 'settings' | 'command' | 'email';

export interface ResetLinkTarget {
  userId: string;
  hasPassword: boolean;
}

/** Ends the account's open links: they are marked stopped and their verification rows go, so none of them works any more. */
const stopOpen = (userId: string, at: Date, except: string | null) => sql`
  WITH stopped AS (
    UPDATE password_reset_links SET stopped_at = ${at.toISOString()}::timestamptz
     WHERE user_id = ${userId} AND used_at IS NULL AND stopped_at IS NULL
       AND (${except}::text IS NULL OR verification_identifier <> ${except}::text)
    RETURNING verification_identifier)
  DELETE FROM auth_verifications WHERE identifier IN (SELECT verification_identifier FROM stopped)`;

export function passwordResetLinks(db: DbExecutor) {
  return {
    /** The account with this address (case-insensitively) and whether it has a password, or null. */
    async byEmail(email: string): Promise<ResetLinkTarget | null> {
      const { rows } = await db.execute<{ id: string; has_password: boolean }>(sql`SELECT u.id, EXISTS (SELECT 1 FROM auth_accounts c WHERE c.user_id = u.id
        AND c.provider_id = 'credential' AND c.password IS NOT NULL) AS has_password FROM auth_users u WHERE lower(u.email) = lower(${email.trim()})`);
      return rows[0] ? { userId: rows[0].id, hasPassword: rows[0].has_password } : null;
    },

    /** The company roles of the maker and of the person, and whether the person has a password (Settings › Company). */
    async roles(makerId: string, userId: string): Promise<{ maker: string | null; person: string | null; hasPassword: boolean }> {
      const { rows } = await db.execute<{ maker: string | null; person: string | null; has_password: boolean }>(sql`SELECT
          (SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id AND w.company WHERE m.user_id = ${makerId}) AS maker,
          (SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id AND w.company WHERE m.user_id = ${userId}) AS person,
          EXISTS (SELECT 1 FROM auth_accounts c WHERE c.user_id = ${userId} AND c.provider_id = 'credential' AND c.password IS NOT NULL) AS has_password`);
      const row = rows[0];
      return { maker: row?.maker ?? null, person: row?.person ?? null, hasPassword: !!row?.has_password };
    },

    /**
     * Records a link whose verification row exists (`identifier` is its stored, hashed identifier) and stops the account's earlier links:
     * the newest link is the one that works.
     */
    async record(link: { userId: string; identifier: string; via: ResetLinkVia; madeBy: string | null; expiresAt: Date; now?: Date }): Promise<void> {
      const now = link.now ?? new Date();
      await db.execute(stopOpen(link.userId, now, link.identifier));
      await db.execute(sql`INSERT INTO password_reset_links (id, user_id, verification_identifier, via, made_by, created_at, expires_at)
        VALUES (${randomUUID()}, ${link.userId}, ${link.identifier}, ${link.via}, ${link.madeBy}, ${now.toISOString()}::timestamptz,
          ${link.expiresAt.toISOString()}::timestamptz) ON CONFLICT (verification_identifier) DO NOTHING`);
    },

    /** Writes the verification row of a link made by Flux itself (Settings › Company, `./flux reset-link`), as Better Auth's own reset writes it. */
    async insertVerification(identifier: string, userId: string, expiresAt: Date): Promise<void> {
      await db.execute(sql`INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at)
        VALUES (${randomUUID()}, ${identifier}, ${userId}, ${expiresAt.toISOString()}::timestamptz, now(), now())`);
    },

    /** The link with this identifier was used (Better Auth already deleted its verification row). */
    async markUsed(identifier: string, at = new Date()): Promise<void> {
      await db.execute(sql`UPDATE password_reset_links SET used_at = ${at.toISOString()}::timestamptz WHERE verification_identifier = ${identifier} AND used_at IS NULL`);
    },

    /** A link of the account was used (#1471): every other open link stops working. A change in Settings › Account stops none. */
    async stopAll(userId: string, at = new Date()): Promise<void> {
      await db.execute(stopOpen(userId, at, null));
    },
  };
}

export type PasswordResetLinks = ReturnType<typeof passwordResetLinks>;
