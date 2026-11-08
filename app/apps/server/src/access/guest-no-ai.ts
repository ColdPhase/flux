import { ForbiddenError } from '@flux/core';
import { isGuestOnly, type DbExecutor } from '@flux/db';

/**
 * F-036: a guest has no AI (assistant.md). The pages that connect it are hidden from a guest, and the server refuses the two steps that make a
 * connection (saving an API key, starting a plan sign-in) for someone who is a guest in every workspace they belong to, so a direct
 * address or a hand-made request changes nothing (#959).
 */
export async function requireNotGuest(db: DbExecutor, userId: string): Promise<void> {
  if (await isGuestOnly(db, userId)) throw new ForbiddenError('A guest has no AI', 'GUEST_NO_AI');
}
