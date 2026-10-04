import { getMe } from '../api/auth';
import { createWorkspace, listWorkspaces } from '../api/sketches';

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

/**
 * The person's own space for private notes and sketches (#190 HOME-3): asks the server which
 * spaces exist now (the shell's list may be older), and when there are none creates "Personal"
 * with a key stable per account, so a double Enter, two tabs, or a sketch and a note at the same
 * moment all end up with one space. Returns null when several spaces exist and the person chooses.
 * The spaces listed and the one created are this account's: the session is checked before each.
 */
export async function ensurePersonalSpace(userId: string, signal?: AbortSignal): Promise<string | null> {
  await assertSignedInAs(userId, signal);
  const spaces = await listWorkspaces(signal);
  if (spaces.length === 1) return spaces[0]!.id;
  if (spaces.length > 1) return null;
  await assertSignedInAs(userId, signal);
  return (await createWorkspace('Personal', `personal-space-v1:${userId}`)).id;
}
