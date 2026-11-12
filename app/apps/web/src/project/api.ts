import {
  WORKSPACES_PATH, projectAiPolicyPath, projectLeavePath, projectPath, workspaceProjectsPath, type SetSpaceAiResult, type SpaceAiState,
  type WorkspaceMember, type Page, type Project, workspaceMembersPath, IDEMPOTENCY_KEY_HEADER, spaceIconPath, type SpaceIcon,
} from '@flux/contracts';
import { KEEP_MS, request } from '../api/client';
import { isWorkspaceLocked, type EncryptedWorkspace } from '../encryption/api';

/**
 * Workspaces and projects the person can open, and creating them (#29, #351). An encrypted workspace that waits to be
 * unlocked (F-030, #655) is not asked for projects (their names are sealed): it is returned in `lockedWorkspaces`, and so
 * is one that locked between the two reads (`423`).
 */
export async function listAccessibleProjects(signal?: AbortSignal, read?: EncryptedWorkspace[]) {
  // The shell reads the workspaces once and asks for their projects and conversations beside each other (#850); a caller that has the
  // list passes it.
  const all = read ?? await request<EncryptedWorkspace[]>(WORKSPACES_PATH, { signal });
  const workspaces: EncryptedWorkspace[] = [];
  const lockedWorkspaces: EncryptedWorkspace[] = all.filter((workspace) => workspace.encryption?.state === 'locked');
  const projects: Project[] = [];
  const open = all.filter((workspace) => !lockedWorkspaces.includes(workspace));
  // Every workspace at once, in the list's order.
  const reads = await Promise.all(open.map(async (workspace) => {
    const found: Project[] = [];
    try {
      for (let offset = 0; ; offset += 100) {
        const page = await request<Page<Project>>(`${workspaceProjectsPath(workspace.id)}?limit=100&offset=${offset}`, { signal });
        found.push(...page.items);
        if (offset + page.items.length >= page.total || page.items.length === 0) break;
      }
    } catch (error) {
      if (!isWorkspaceLocked(error)) throw error;
      return { workspace, found: null };
    }
    return { workspace, found };
  }));
  for (const { workspace, found } of reads) {
    if (!found) { lockedWorkspaces.push(workspace); continue; }
    workspaces.push(workspace);
    projects.push(...found);
  }
  return { workspaces, lockedWorkspaces, projects };
}
// A new space carries the intent's Idempotency-Key: a retry after a lost 201 replays it instead of making a second one. The people are
// added as members and the creator is its admin, in the same command (F-037).
export const createProject = (workspaceId: string, name: string, idempotencyKey: string, options: { ai?: boolean; people?: string[] } = {}) =>
  request<Project>(workspaceProjectsPath(workspaceId), { method: 'POST', body: { name, visibility: 'restricted', ...options }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
/** A space admin, or a company owner or admin, renames the space. */
export const renameProject = (projectId: string, name: string, idempotencyKey: string) =>
  request<Project>(projectPath(projectId), { method: 'PATCH', body: { name }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
/** Erases the space and everything in it. */
export const deleteProject = (projectId: string) => request<null>(projectPath(projectId), { method: 'DELETE' });
/** The caller leaves the space. */
export const leaveProject = (projectId: string) => request<null>(projectLeavePath(projectId), { method: 'POST' });
/** Turns AI off or on in the space (AG-10); turning it off stops what agents were doing there at once. */
export const setSpaceAi = (projectId: string, state: SpaceAiState, idempotencyKey: string) =>
  request<SetSpaceAiResult>(projectAiPolicyPath(projectId), { method: 'PUT', body: { state }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
/** `fresh`: read now, not from the answer kept a moment ago (the entry into a space, #862). */
export const getProject = (id: string, signal?: AbortSignal, fresh = false) => request<Project>(projectPath(id), { signal, share: true, keep: KEEP_MS, fresh });
export const listWorkspaceMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(workspaceMembersPath(workspaceId), { signal, share: true, keep: KEEP_MS });

/** A space's icon (F-040): an emoji, a picture (its bytes as they are; the server decides by them what it is), or back to the letter. */
export const setSpaceEmoji = (projectId: string, emoji: string) => request<SpaceIcon>(spaceIconPath(projectId), { method: 'PUT', body: { emoji } });
export const setSpacePicture = (projectId: string, file: Blob) =>
  request<SpaceIcon>(spaceIconPath(projectId), { method: 'PUT', bytes: new Blob([file], { type: 'application/octet-stream' }) });
export const removeSpaceIcon = (projectId: string) => request<null>(spaceIconPath(projectId), { method: 'DELETE' });
