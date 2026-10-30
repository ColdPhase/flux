import {
  WORKSPACES_PATH, projectPath, workspaceProjectsPath, type ProjectTemplate, type ProjectViewId, projectViewsPath, type WorkspaceMember, type Page, type Project, type Workspace, workspaceMembersPath, IDEMPOTENCY_KEY_HEADER,
} from '@flux/contracts';
import { request } from '../api/client';

/** Workspaces and projects the person can open, and creating them (#29, #351). */
export async function listAccessibleProjects(signal?: AbortSignal) {
  const workspaces = await request<Workspace[]>(WORKSPACES_PATH, { signal });
  const projects: Project[] = [];
  for (const workspace of workspaces) {
    for (let offset = 0; ; offset += 100) {
      const page = await request<Page<Project>>(`${workspaceProjectsPath(workspace.id)}?limit=100&offset=${offset}`, { signal });
      projects.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
  }
  return { workspaces, projects };
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
