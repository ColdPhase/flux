/**
 * Files picked in the phone's "+" Create sheet ("File or link", F-026 S2) before its project's
 * conversation is open. The picker has to open inside the tap, so the sheet picks them and the
 * project's message composer takes them into its private draft once it shows. Held for this visit only.
 */
let handed: { accountId: string; projectId: string; files: File[] } | null = null;

export function handFilesToComposer(accountId: string, projectId: string, files: File[]) {
  handed = files.length ? { accountId, projectId, files } : null;
}

/** The files handed to this account's project, once; null when there are none. */
export function takeHandedFiles(accountId: string, projectId: string): File[] | null {
  if (!handed || handed.accountId !== accountId || handed.projectId !== projectId) return null;
  const { files } = handed;
  handed = null;
  return files;
}
