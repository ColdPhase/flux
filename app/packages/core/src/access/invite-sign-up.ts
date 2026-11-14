import type { Database } from '../types.js';
import { ForbiddenError } from './errors.js';
import { previewInvite } from './invite-joining.js';
import type { InviteSigner } from './invite-tokens.js';
import type { AccessPorts } from './repositories.js';

/**
 * Whether a new account may be made from this invite link (#1471), before it exists: the link works (404/410 as the preview) and, for a
 * link locked to an address, `email` is that address. With `verifiedEmailOnly` (single sign-on configured) a locked link needs a verified
 * address, which a new password account never has, so it is refused the same way.
 */
export async function checkInviteForSignUp(token: unknown, email: string, db: Database, ports: Pick<AccessPorts, 'workspaces' | 'invites' | 'access' | 'events' | 'projects'>,
  signer: InviteSigner, options: { verifiedEmailOnly?: boolean } = {}, now = new Date()): Promise<void> {
  const preview = await previewInvite(null, token, db, ports, signer, now);
  if (preview.email !== null && (email.trim().toLowerCase() !== preview.email || options.verifiedEmailOnly)) {
    throw new ForbiddenError('This invite link is for a different email address', 'INVITE_WRONG_ACCOUNT');
  }
}
