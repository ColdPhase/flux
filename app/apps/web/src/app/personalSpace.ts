import { createWorkspace, listWorkspaces } from '../api/sketches';

/**
 * The person's own space for private notes and sketches (#190 HOME-3): asks the server which
 * spaces exist now (the shell's list may be older), and when there are none creates "Personal"
 * with a key stable per account, so a double Enter, two tabs, or a sketch and a note at the same
 * moment all end up with one space. Returns null when several spaces exist and the person chooses.
 */
export async function ensurePersonalSpace(userId: string, signal?: AbortSignal): Promise<string | null> {
  const spaces = await listWorkspaces(signal);
  if (spaces.length === 1) return spaces[0]!.id;
  if (spaces.length > 1) return null;
  return (await createWorkspace('Personal', `personal-space-v1:${userId}`)).id;
}
