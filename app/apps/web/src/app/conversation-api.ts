import {
  WORKSPACES_PATH, conversationMessagesPath, conversationPath, materialPath,
  materialVersionPath, projectConversationRootsPath, projectConversationsPath, projectMaterialsPath, projectPath, projectTaskNoticesPath, workspaceProjectsPath,
  type Conversation, type ConversationMessage, type ConversationRootWindow, type ConversationSummary, type CreateMaterialCommand,
  type ProjectTemplate, type ProjectViewId, projectViewsPath,
  type Draft, type WorkspaceMember, type Material, type MaterialOrDoc, type MaterialVersion, type Page, type Project, type SendMessageCommand, type TaskCreationNotice, type Workspace, workspaceDraftsPath,
  IDEMPOTENCY_KEY_HEADER, projectObservationsPath, projectReceiptsPath, type MessageReceiptsResult, type ObserveMessagesResult,
} from '@flux/contracts';
import { request } from '../api/client';
import { isWorkspaceLocked, type EncryptedWorkspace } from '../encryption/api';

/**
 * Every workspace of the person with the projects they can open. An encrypted workspace that waits to be unlocked (F-030,
 * #655) is not asked for projects (their names are sealed): it is returned in `lockedWorkspaces`, and so is one that
 * locked between the two reads (`423`).
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
export const listConversations = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<ConversationSummary>>(`${projectConversationsPath(projectId)}?limit=100&offset=${offset}`, { signal });
/** The project's one stream (UI116-1): the newest roots, or those before a conversation id. */
export const listConversationRoots = (projectId: string, options: { before?: string | null; limit?: number } = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  if (options.limit) query.set('limit', String(options.limit));
  if (options.before) query.set('before', options.before);
  const search = query.toString();
  return request<ConversationRootWindow>(`${projectConversationRootsPath(projectId)}${search ? `?${search}` : ''}`, { signal });
};
/** The project's task announcements (UI116-3), newest first. */
export const listTaskNotices = (projectId: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
  request<Page<TaskCreationNotice>>(`${projectTaskNoticesPath(projectId)}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`, { signal });
export const getConversation = (id: string, signal?: AbortSignal) => request<Conversation>(conversationPath(id), { signal });
export const olderMessages = (id: string, beforeSequence: number, signal?: AbortSignal, limit?: number) =>
  request<Conversation>(`${conversationPath(id)}?beforeSequence=${beforeSequence}${limit ? `&limit=${limit}` : ''}`, { signal });
export const startConversation = (projectId: string, command: SendMessageCommand) => request<Conversation>(projectConversationsPath(projectId), { method: 'POST', body: command });
export const reply = (id: string, command: SendMessageCommand) => request<ConversationMessage>(conversationMessagesPath(id), { method: 'POST', body: command });
export const listMaterials = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<Material>>(`${projectMaterialsPath(projectId)}?limit=100&offset=${offset}`, { signal });
export const publishMaterial = (projectId: string, command: CreateMaterialCommand) => request<Material>(projectMaterialsPath(projectId), { method: 'POST', body: command });
export const getMaterial = (id: string, signal?: AbortSignal) => request<MaterialOrDoc>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });

export const listDrafts = (workspaceId: string, signal?: AbortSignal, offset = 0) => request<Page<Draft>>(`${workspaceDraftsPath(workspaceId)}?limit=100&offset=${offset}`, { signal });
/** A private draft; an `idempotencyKey` makes a retry return the same draft instead of a second one. */
export const createPrivateDraft = (workspaceId: string, title: string, body: string, idempotencyKey?: string, signal?: AbortSignal) =>
  request<Draft>(workspaceDraftsPath(workspaceId), { method: 'POST', body: { title, body }, signal, ...(idempotencyKey ? { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } } : {}) });
export const listWorkspaceMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(`${WORKSPACES_PATH}/${workspaceId}/members`, { signal });

/** Viewing receipts of the project's conversation (#534): what this person saw, and who saw the runs of their own messages. */
export const observeProjectMessages = (projectId: string, messageIds: string[]) =>
  request<ObserveMessagesResult>(projectObservationsPath(projectId), { method: 'POST', body: { messageIds } });
export const projectReceipts = (projectId: string, runs: string[][], signal?: AbortSignal) =>
  request<MessageReceiptsResult>(projectReceiptsPath(projectId), { method: 'POST', body: { runs }, signal });
