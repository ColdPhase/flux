import { ForbiddenError } from '@flux/core';
import { isCompanyGuest, isRemovedFromCompany, type DbExecutor } from '@flux/db';

/**
 * F-036: a guest has no AI (assistant.md). The pages that connect it are hidden from a guest, and the server refuses the two steps that make a
 * connection (saving an API key, starting a plan sign-in) for someone who is a guest of the company (the same role the web reads), so a direct
 * address or a hand-made request changes nothing (#959).
 */
export async function requireNotGuest(db: DbExecutor, userId: string): Promise<void> {
  if (await isCompanyGuest(db, userId)) throw new ForbiddenError('A guest has no AI', 'GUEST_NO_AI');
}

/**
 * As `requireNotGuest`, and someone who left the company or was removed, whose session still signs them in, is refused too: the steps that
 * make the server reach a provider (listing its models, saving or testing a key) are for the company's people (v0.2.1 review).
 */
export async function requireCompanyPersonForAi(db: DbExecutor, userId: string): Promise<void> {
  await requireNotGuest(db, userId);
  if (await isRemovedFromCompany(db, userId)) throw new ForbiddenError('You are no longer in this company', 'NOT_IN_COMPANY');
}
