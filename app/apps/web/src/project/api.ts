import {
  WORKSPACES_PATH, projectPath, workspaceProjectsPath, type ProjectTemplate, type ProjectViewId, projectViewsPath, type WorkspaceMember, type Page, type Project, type Workspace, workspaceMembersPath, IDEMPOTENCY_KEY_HEADER,
} from '@flux/contracts';
import { request } from '../api/client';
import { isWorkspaceLocked, type EncryptedWorkspace } from '../encryption/api';

/**
 * Workspaces and projects the person can open, and creating them (#29, #351). An encrypted workspace that waits to be
 * unlocked (F-030, #655) is not asked for projects (their names are sealed): it is returned in `lockedWorkspaces`, and so
 * is one that locked between the two reads (`423`).
 */
export async function listAccessibleProjects(signal?: AbortSignal) {
  const all = await request<EncryptedWorkspace[]>(WORKSPACES_PATH, { signal });
  const workspaces: EncryptedWorkspace[] = [];
  const lockedWorkspaces: EncryptedWorkspace[] = all.filter((workspace) => workspace.encryption?.state === 'locked');
  const projects: Project[] = [];
  for (const workspace of all) {
    if (lockedWorkspaces.includes(workspace)) continue;
    const found: Project[] = [];
    try {
      for (let offset = 0; ; offset += 100) {
        const page = await request<Page<Project>>(`${workspaceProjectsPath(workspace.id)}?limit=100&offset=${offset}`, { signal });
        found.push(...page.items);
        if (offset + page.items.length >= page.total || page.items.length === 0) break;
      }
    } catch (error) {
      if (!isWorkspaceLocked(error)) throw error;
      lockedWorkspaces.push(workspace);
      continue;
    }
    workspaces.push(workspace);
    projects.push(...found);
  }
  return { workspaces, lockedWorkspaces, projects };
}
// First-run creations carry the intent's Idempotency-Key: a retry after a lost 201 replays it instead of duplicating.
export const createWorkspace = (name: string, idempotencyKey: string) =>
  request<Workspace>(WORKSPACES_PATH, { method: 'POST', body: { name }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
export const createProject = (workspaceId: string, name: string, template: ProjectTemplate, idempotencyKey: string) =>
  request<Project>(workspaceProjectsPath(workspaceId), { method: 'POST', body: { name, visibility: 'restricted', template }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
/** Adds Map, Wiki or Agents to a project (#351); adding one it has changes nothing. */
export const addProjectView = (projectId: string, view: ProjectViewId) =>
  request<Project>(projectViewsPath(projectId), { method: 'POST', body: { view }, headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() } });
export const getProject = (id: string, signal?: AbortSignal) => request<Project>(projectPath(id), { signal });
export const listWorkspaceMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(workspaceMembersPath(workspaceId), { signal });
