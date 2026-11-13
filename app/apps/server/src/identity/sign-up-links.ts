import { createHash, timingSafeEqual } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { accessPorts, schema, type Database } from '@flux/db';
import { DomainError, joinCompany } from '@flux/core';
import { eq } from 'drizzle-orm';

/**
 * The invite links a sign-up may come from (F-035, #1471). The access module implements it (`inviteSignUp`): `check` refuses a link
 * that does not work or is locked to another address before the account exists; `accept` joins the new account with the link's role.
 */
export interface InviteSignUp {
  check(token: string, email: string): Promise<void>;
  accept(userId: string, token: string): Promise<void>;
}

export interface SignUpLinkOptions {
  db: Database;
  /** `FLUX_SETUP_TOKEN`, or null when unset. */
  setupToken: string | null;
  /** Null without invite links (no signer): only the setup link makes an account. */
  invites: InviteSignUp | null;
  /** A test deployment (fixture token and failure injection) also makes an account without a link: its suites create hundreds of people. */
  open: boolean;
}

/** What a sign-up body says it comes from. The tokens are never logged, stored with the account or echoed. */
function linkOf(body: unknown): { setupToken?: string; inviteToken?: string } {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' && value[key] ? (value[key] as string).slice(0, 512) : undefined);
  return { setupToken: text('setupToken'), inviteToken: text('inviteToken') };
}

const digest = (text: string) => createHash('sha256').update(text).digest();
const sameToken = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

/** A refusal Better Auth answers with its status and code (a domain error from the invite check keeps its own). */
function refusal(error: unknown): APIError {
  if (error instanceof APIError) return error;
  if (error instanceof DomainError) {
    const status = ({ 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 410: 'GONE', 429: 'TOO_MANY_REQUESTS' } as const)[error.status as 403] ?? 'BAD_REQUEST';
    return new APIError(status, { message: error.message, code: error.code });
  }
  throw error;
}

/**
 * Accounts only from a link (#1471, docs/development/access-policy.md#accounts-only-from-a-link-1471): the first account, the company's
 * owner, from the setup link; every other one from an invite link (single sign-on makes its own accounts and does not pass here).
 * `check` runs before Better Auth makes the account, `made` right after it exists, in the same request.
 */
export function createSignUpLinks({ db, setupToken, invites, open }: SignUpLinkOptions) {
  const hasCompany = async () => !!await accessPorts.workspaces(db).company();
  const undo = async (userId: string) => { await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId)); };
  return {
    async check(body: unknown): Promise<void> {
      const { setupToken: setup, inviteToken: invite } = linkOf(body);
      const email = typeof (body as { email?: unknown } | null)?.email === 'string' ? (body as { email: string }).email : '';
      if (setup !== undefined) {
        if (await hasCompany()) throw new APIError('CONFLICT', { message: 'This Flux is already set up. Sign in, or ask for an invite link', code: 'SETUP_DONE' });
        if (!setupToken) throw new APIError('FORBIDDEN', { message: 'This Flux has no setup link yet. Run ./flux up on the server to make one', code: 'SETUP_LINK_MISSING' });
        if (!sameToken(setup, setupToken)) throw new APIError('FORBIDDEN', { message: 'This setup link is not this Flux’s. Open the whole link that ./flux up printed', code: 'SETUP_LINK_INVALID' });
        return;
      }
      if (invite !== undefined && invites) {
        try { await invites.check(invite, email); } catch (error) { throw refusal(error); }
        return;
      }
      if (open) return;
      throw new APIError('FORBIDDEN', { message: 'Accounts on this Flux are made from an invite link. Ask an owner or admin of your company for one', code: 'SIGNUP_NEEDS_LINK' });
    },

    /** The account exists: it sets up the company, or joins it from the invite. A link that stopped working meanwhile removes it again. */
    async made(userId: string, body: unknown): Promise<void> {
      const { setupToken: setup, inviteToken: invite } = linkOf(body);
      if (setup !== undefined) {
        // Two sign-ups from the setup link at once: the advisory lock in `joinCompany` lets one set the company up; the other is undone.
        if (await joinCompany(userId, { sso: false }, db, accessPorts) === 'created') return;
        await undo(userId);
        throw new APIError('CONFLICT', { message: 'This Flux is already set up. Sign in, or ask for an invite link', code: 'SETUP_DONE' });
      }
      if (invite !== undefined && invites) {
        try { await invites.accept(userId, invite); } catch (error) { await undo(userId); throw refusal(error); }
        return;
      }
      // A test deployment's sign-up without a link: the first one sets the company up, as before (F-037).
      await joinCompany(userId, { sso: false }, db, accessPorts);
    },
  };
}

export type SignUpLinks = ReturnType<typeof createSignUpLinks>;
