import { getMe } from '../api/auth';

/** The browser's one session now belongs to someone else (a sign-in in another tab): nothing was written. */
export class AccountChangedError extends Error {
  constructor() { super('You are signed in as someone else in another tab. Nothing was saved; reload this page.'); }
}

/**
 * Requests carry the browser's one session cookie, so a page still showing one account would write
 * into another after a sign-in elsewhere. Writes made on this account's behalf ask first (#211).
 */
export async function assertSignedInAs(userId: string, signal?: AbortSignal): Promise<void> {
  if ((await getMe(signal))?.user.id !== userId) throw new AccountChangedError();
}
